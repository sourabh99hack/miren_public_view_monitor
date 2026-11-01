import os
import json
from datetime import timedelta
from functools import wraps
from pathlib import Path
import threading
import time
from urllib.parse import quote, unquote, urlsplit, urlunsplit
import cv2
from flask import Response, abort, stream_with_context
from dotenv import load_dotenv
from flask import (
    Flask,
    render_template,
    request,
    redirect,
    url_for,
    session,
    flash,
    jsonify,
)
from flask_wtf.csrf import CSRFProtect
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename

load_dotenv()

app = Flask(__name__)

secret_key = os.getenv("MIREN_SECRET_KEY")
admin_password = os.getenv("MIREN_ADMIN_PASSWORD")

if not secret_key or not admin_password:
    raise RuntimeError(
        "Set MIREN_SECRET_KEY and MIREN_ADMIN_PASSWORD in your .env file."
    )

app.config.update(
    SECRET_KEY=secret_key,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.getenv(
        "MIREN_HTTPS", "false"
    ).lower() == "true",
    PERMANENT_SESSION_LIFETIME=timedelta(minutes=30),
    MAX_CONTENT_LENGTH=3 * 1024 * 1024,
)

csrf = CSRFProtect(app)
ADMIN_PASSWORD_HASH = generate_password_hash(admin_password)

BASE_DIR = Path(__file__).resolve().parent
STATE_FILE = BASE_DIR / "data" / "camera_state.json"
CONFIG_FILE = BASE_DIR / "data" / "camera_config.json"
UPLOAD_DIR = BASE_DIR / "static" / "uploads"

ALLOWED_LOGO_EXTENSIONS = {"png", "jpg", "jpeg", "webp"}

DEFAULT_CAMERA_CONFIG = {
    "camera_name": "Entrance",
    "camera_host": "",
    "rtsp_port": 554,
    "username": "",
    "password": "",
    "stream": "main",
    "custom_rtsp_url": "",
    "logo_path": "",
    "notice_text": "VIDEO SURVEILLANCE IN PROGRESS",
    "rtsp_autoconnect": True,
}


# def load_camera_config():
#     try:
#         with CONFIG_FILE.open("r", encoding="utf-8") as file:
#             saved = json.load(file)

#         if isinstance(saved, dict):
#             config = DEFAULT_CAMERA_CONFIG.copy()
#             config.update({
#                 key: saved[key]
#                 for key in config
#                 if key in saved
#             })
#             return config

#     except FileNotFoundError:
#         pass
#     except (OSError, json.JSONDecodeError):
#         app.logger.exception("Unable to load camera configuration.")

#     return DEFAULT_CAMERA_CONFIG.copy()


def load_camera_config():
    try:
        with CONFIG_FILE.open("r", encoding="utf-8") as file:
            saved = json.load(file)

        if isinstance(saved, dict):
            config = DEFAULT_CAMERA_CONFIG.copy()
            config.update({
                key: saved[key]
                for key in config
                if key in saved
            })

            # Migrate older configurations that don't have connection_mode.
            if "connection_mode" not in saved:
                if str(saved.get("custom_rtsp_url", "")).strip():
                    config["connection_mode"] = "custom"
                elif saved.get("stream") == "sub":
                    config["connection_mode"] = "sub"
                else:
                    config["connection_mode"] = "main"

            return config

    except FileNotFoundError:
        pass
    except (OSError, json.JSONDecodeError):
        app.logger.exception(
            "Unable to load camera configuration."
        )

    return DEFAULT_CAMERA_CONFIG.copy()



def save_camera_config(config):
    CONFIG_FILE.parent.mkdir(parents=True, exist_ok=True)
    temp_file = CONFIG_FILE.with_suffix(".tmp")

    with temp_file.open("w", encoding="utf-8") as file:
        json.dump(config, file, indent=2)
        file.flush()
        os.fsync(file.fileno())

    try:
        os.chmod(temp_file, 0o600)
    except OSError:
        app.logger.warning(
            "Could not restrict camera configuration file permissions."
        )

    temp_file.replace(CONFIG_FILE)

    try:
        os.chmod(CONFIG_FILE, 0o600)
    except OSError:
        app.logger.warning(
            "Could not restrict camera configuration file permissions."
        )


camera_config = load_camera_config()



class RTSPStream:
    """Manage one RTSP capture and its background reader thread."""

    def __init__(self):
        self.lock = threading.Lock()
        self.lifecycle_lock = threading.Lock()
        self.stop_event = threading.Event()
        self.capture = None
        self.frame = None
        self.connected = False
        self.running = False
        self.thread = None
        self.last_error = "Stream has not been started."
        self.current_url = None

    @staticmethod
    def build_url(config):
        mode = config.get("connection_mode")

        # Backward compatibility for older saved configurations.
        if mode not in {"main", "sub", "custom"}:
            mode = (
                "custom"
                if config.get("custom_rtsp_url")
                else config.get("stream", "main")
            )

        if mode == "custom":
            url = (config.get("custom_rtsp_url") or "").strip()

            if not url:
                raise ValueError("Enter a Custom RTSP URL.")

        else:
            host = (config.get("camera_host") or "").strip()

            if not host:
                raise ValueError("Enter a camera host or IP address.")

            try:
                port = int(config.get("rtsp_port", 554))
            except (TypeError, ValueError):
                raise ValueError("RTSP port must be between 1 and 65535.")

            if not 1 <= port <= 65535:
                raise ValueError("RTSP port must be between 1 and 65535.")

            stream = "sub" if mode == "sub" else "main"

            # Support IPv6 addresses as well as IPv4 and hostnames.
            if ":" in host and not host.startswith("["):
                host = f"[{host}]"

            url = f"rtsp://{host}:{port}/{stream}"

        parts = urlsplit(url)

        if parts.scheme not in ("rtsp", "rtsps") or not parts.hostname:
            raise ValueError("A valid RTSP URL is required.")

        # Validate the port, including malformed port values.
        try:
            url_port = parts.port
        except ValueError:
            raise ValueError("The RTSP URL contains an invalid port.")

        if url_port is not None and not 1 <= url_port <= 65535:
            raise ValueError("RTSP port must be between 1 and 65535.")

        # Add credentials from the separately stored configuration.
        # A URL containing its own credentials is preserved as-is.
        if parts.username is None and config.get("username"):
            auth = quote(config["username"], safe="")
            password = quote(config.get("password", ""), safe="")

            if password:
                auth += ":" + password

            host = parts.hostname

            if ":" in host and not host.startswith("["):
                host = f"[{host}]"

            netloc = f"{auth}@{host}"

            if url_port is not None:
                netloc += f":{url_port}"

            parts = parts._replace(netloc=netloc)

        return urlunsplit(parts)

    
    # @staticmethod
    # def build_url(config):
    #     url = (config.get("custom_rtsp_url") or "").strip()

    #     if not url:
    #         host = (config.get("camera_host") or "").strip()
    #         port = int(config.get("rtsp_port", 554))
    #         stream = config.get("stream", "main")
    #         if not host:
    #             raise ValueError("Enter a camera host or custom RTSP URL.")
    #         url = f"rtsp://{host}:{port}/{stream}"

    #     parts = urlsplit(url)
    #     if parts.scheme not in ("rtsp", "rtsps") or not parts.hostname:
    #         raise ValueError("A valid RTSP URL is required.")

    #     if parts.username is None and config.get("username"):
    #         auth = quote(config["username"], safe="")
    #         password = quote(config.get("password", ""), safe="")
    #         if password:
    #             auth += ":" + password

    #         host = parts.hostname
    #         if ":" in host and not host.startswith("["):
    #             host = f"[{host}]"
    #         netloc = f"{auth}@{host}"
    #         if parts.port:
    #             netloc += f":{parts.port}"
    #         parts = parts._replace(netloc=netloc)

    #     return urlunsplit(parts)

    

    def start(self, config):
        with self.lifecycle_lock:
            try:
                url = self.build_url(config)
            except (ValueError, TypeError) as exc:
                self.last_error = str(exc)
                return False

            # A repeated Test Connection must not reopen an active capture.
            with self.lock:
                if self.running and self.current_url == url:
                    return True

            self._stop_locked()

            # Pass timeouts at open time, not after opening the stream.
            params = [
                cv2.CAP_PROP_OPEN_TIMEOUT_MSEC, 5000,
                cv2.CAP_PROP_READ_TIMEOUT_MSEC, 5000,
            ]

            try:
                capture = cv2.VideoCapture(
                    url, cv2.CAP_FFMPEG, params
                )
            except Exception:
                self.last_error = "Could not initialize RTSP capture."
                app.logger.exception("RTSP capture initialization failed.")
                return False

            if not capture.isOpened():
                capture.release()
                self.last_error = "Unable to open the RTSP stream."
                return False

            self.stop_event = threading.Event()
            self.capture = capture
            self.frame = None
            self.connected = False
            self.running = True
            self.current_url = url
            self.last_error = ""

            self.thread = threading.Thread(
                target=self._read_frames,
                args=(capture, self.stop_event),
                daemon=True,
                name="rtsp-frame-reader",
            )
            self.thread.start()
            return True
        
    def _read_frames(self, capture, stop_event):
        try:
            while not stop_event.is_set():
                ok, frame = capture.read()

                if stop_event.is_set():
                    break

                if not ok or frame is None:
                    with self.lock:
                        self.connected = False
                        self.last_error = (
                            "RTSP stream stopped delivering frames."
                        )
                    break

                with self.lock:
                    self.frame = frame
                    self.connected = True
                    self.last_error = ""

        except Exception:
            app.logger.exception("RTSP frame reader failed.")
            with self.lock:
                self.connected = False
                self.last_error = "RTSP frame reader failed."

        finally:
            with self.lock:
                self.connected = False

    def get_frame(self):
        with self.lock:
            return None if self.frame is None else self.frame.copy()

    def status(self):
        with self.lock:
            return {
                "connected": self.connected,
                "error": self.last_error,
            }

    def _stop_locked(self):
        thread = self.thread
        capture = self.capture

        self.stop_event.set()

        # Do not release VideoCapture while its reader thread is using it.
        if thread is not None and thread.is_alive():
            thread.join(timeout=7)

        if thread is not None and thread.is_alive():
            self.last_error = (
                "Previous RTSP reader did not stop safely. "
                "Restart Flask before retrying."
            )
            self.running = False
            return False

        if capture is not None:
            capture.release()

        self.capture = None
        self.thread = None
        self.frame = None
        self.connected = False
        self.running = False
        self.current_url = None
        return True

    def stop(self):
        with self.lifecycle_lock:
            return self._stop_locked()


rtsp_stream = RTSPStream()

# ==========================================
# RTSP CONNECTION MANAGER
# ==========================================


class RTSPConnectionManager:
    """Manage RTSP auto-connect, retry, and manual disconnect."""

    def __init__(self, stream, retry_interval=5, connect_timeout=12):
        self.stream = stream
        self.retry_interval = retry_interval
        self.connect_timeout = connect_timeout
        self.lock = threading.Lock()
        self.enabled = bool(camera_config.get("rtsp_autoconnect", True))
        self.thread = None
        self.last_attempt = 0.0

    def start(self):
        with self.lock:
            if self.thread and self.thread.is_alive():
                return

            self.thread = threading.Thread(
                target=self._run,
                daemon=True,
                name="rtsp-connection-manager",
            )
            self.thread.start()

    

    def connect(self):
        global camera_config

        new_config = camera_config.copy()
        new_config["rtsp_autoconnect"] = True

        try:
            save_camera_config(new_config)
        except OSError:
            app.logger.exception(
                "Could not save RTSP auto-connect preference."
            )
            return False

        camera_config = new_config

        with self.lock:
            self.enabled = True
            self.last_attempt = 0.0

        # Ensure the connection manager is running.
        self.start()

        # Start the RTSP stream immediately.
        if not self.stream.start(camera_config):
            app.logger.warning(
                "RTSP connection could not be started: %s",
                self.stream.last_error,
            )

        return True

    def disconnect(self):
        global camera_config

        new_config = camera_config.copy()
        new_config["rtsp_autoconnect"] = False

        try:
            save_camera_config(new_config)
        except OSError:
            app.logger.exception(
                "Could not save RTSP disconnect preference."
            )
            return False

        camera_config = new_config

        with self.lock:
            self.enabled = False

        return self.stream.stop()



    def _run(self):
        while True:
            with self.lock:
                enabled = self.enabled

            has_config = bool(
                camera_config.get("custom_rtsp_url")
                or camera_config.get("camera_host")
            )

            if not enabled or not has_config:
                time.sleep(1)
                continue

            status = self.stream.status()
            now = time.monotonic()

            if status["connected"]:
                time.sleep(1)
                continue

            if self.stream.running:
                if now - self.last_attempt < self.connect_timeout:
                    time.sleep(1)
                    continue

                app.logger.warning(
                    "RTSP stream is not delivering frames. "
                    "Stopping the stale connection before retrying."
                )

                if not self.stream.stop():
                    app.logger.error(
                        "Cannot retry RTSP: previous reader did not stop."
                    )
                    self.last_attempt = now
                    time.sleep(1)
                    continue

                self.last_attempt = now
                time.sleep(1)
                continue

            if now - self.last_attempt >= self.retry_interval:
                self.last_attempt = now
                app.logger.info("Attempting RTSP connection...")

                if not self.stream.start(camera_config):
                    app.logger.warning(
                        "RTSP connection attempt failed: %s",
                        self.stream.last_error,
                    )

            time.sleep(1)


rtsp_manager = RTSPConnectionManager(rtsp_stream)



def load_camera_state():
    try:
        with STATE_FILE.open("r", encoding="utf-8") as file:
            state = json.load(file)

        if (
            isinstance(state, dict)
            and isinstance(state.get("connected"), bool)
        ):
            app.logger.info(
                "Loaded simulator state: connected=%s",
                state["connected"],
            )
            return {"connected": state["connected"]}

        app.logger.warning("Invalid simulator state file: %s", STATE_FILE)

    except FileNotFoundError:
        app.logger.warning("Simulator state file not found: %s", STATE_FILE)
    except (OSError, json.JSONDecodeError):
        app.logger.exception("Could not load simulator state.")

    return {"connected": True}


def save_camera_state(state):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    temp_file = STATE_FILE.with_suffix(".tmp")

    with temp_file.open("w", encoding="utf-8") as file:
        json.dump(state, file, indent=2)
        file.flush()
        os.fsync(file.fileno())

    temp_file.replace(STATE_FILE)


camera_state = load_camera_state()

if not STATE_FILE.exists():
    save_camera_state(camera_state)


def login_required(view):
    @wraps(view)
    def wrapped_view(*args, **kwargs):
        if not session.get("admin_logged_in"):
            return redirect(url_for("login"))
        return view(*args, **kwargs)

    return wrapped_view


# def config_for_browser():
#     """Return configuration without exposing the saved password."""
#     safe_config = camera_config.copy()
#     safe_config["password_configured"] = bool(
#         safe_config.pop("password", "")
#     )
#     return safe_config


def config_for_browser():
    """Return camera configuration without exposing credentials."""
    safe_config = camera_config.copy()

    safe_config["password_configured"] = bool(
        safe_config.pop("password", "")
    )

    # Redact credentials from legacy custom URLs as well.
    custom_url = safe_config.get("custom_rtsp_url", "")

    if custom_url:
        try:
            parts = urlsplit(custom_url)

            if parts.scheme in ("rtsp", "rtsps") and parts.hostname:
                host = parts.hostname

                if ":" in host and not host.startswith("["):
                    host = f"[{host}]"

                netloc = host

                if parts.port is not None:
                    netloc += f":{parts.port}"

                safe_config["custom_rtsp_url"] = urlunsplit(
                    parts._replace(netloc=netloc)
                )
        except ValueError:
            # Never return a malformed credential-bearing URL.
            safe_config["custom_rtsp_url"] = ""

    return safe_config


@app.route("/")
def display():
    return render_template("display.html")


@app.route("/login", methods=["GET", "POST"])
def login():
    if session.get("admin_logged_in"):
        return redirect(url_for("admin"))

    if request.method == "POST":
        password = request.form.get("password", "")

        if check_password_hash(ADMIN_PASSWORD_HASH, password):
            session.clear()
            session["admin_logged_in"] = True
            session.permanent = True
            return redirect(url_for("admin"))

        flash("Invalid password. Please try again.", "error")

    return render_template("login.html")


@app.route("/logout", methods=["POST"])
@login_required
def logout():
    session.clear()
    flash("You have been signed out.", "success")
    return redirect(url_for("login"))


@app.route("/admin")
@login_required
def admin():
    return render_template("admin.html")


@app.route("/health")
def health():
    response = jsonify({
        "status": "ok",
        "service": "MiRen Monitor",
    })
    response.headers["Cache-Control"] = "no-store"
    return response



@app.route("/api/public-display-config", methods=["GET"])
def public_display_config():
    """Expose only branding settings required by the public display."""
    response = jsonify({
        "logo_path": camera_config.get("logo_path", ""),
        "notice_text": camera_config.get(
            "notice_text",
            "VIDEO SURVEILLANCE IN PROGRESS"
        ),
    })

    response.headers["Cache-Control"] = "no-store"
    return response



@app.route("/api/public-status", methods=["GET"])
def public_camera_status():
    """Return the current public display connection status."""

    has_rtsp_config = bool(
        camera_config.get("custom_rtsp_url")
        or camera_config.get("camera_host")
    )

    if has_rtsp_config:
        status = rtsp_stream.status()

        connected = (
            status["connected"]
            and rtsp_stream.running
        )

        mode = "rtsp"
    else:
        connected = bool(camera_state["connected"])
        mode = "simulator"

    response = jsonify({
        "connected": connected,
        "mode": mode,
    })

    response.headers["Cache-Control"] = "no-store"
    return response



@app.route("/api/admin/camera-status", methods=["GET"])
@login_required
def admin_camera_status():
    has_rtsp_config = bool(
        camera_config.get("custom_rtsp_url")
        or camera_config.get("camera_host")
    )

    if has_rtsp_config:
        status = rtsp_stream.status()
        connected = status["connected"] and rtsp_stream.running

        if connected:
            state = "Connected"
        elif rtsp_manager.enabled:
            state = "Connecting" if rtsp_stream.running else "Reconnecting"
        else:
            state = "Disconnected"

        response = jsonify({
            "connected": connected,
            "mode": "rtsp",
            "state": state,
            "error": status["error"],
            "auto_connect": rtsp_manager.enabled,
        })
    else:
        connected = bool(camera_state["connected"])

        response = jsonify({
            "connected": connected,
            "mode": "simulator",
            "state": "Connected" if connected else "Disconnected",
            "state_file": str(STATE_FILE),
            "auto_connect": False,
        })

    response.headers["Cache-Control"] = "no-store"
    return response



@app.route("/api/admin/camera-connect", methods=["POST"])
@login_required
def admin_camera_connect():
    if not (
        camera_config.get("custom_rtsp_url")
        or camera_config.get("camera_host")
    ):
        return jsonify({
            "success": False,
            "message": "Configure the RTSP camera settings first.",
        }), 400

    if not rtsp_manager.connect():
        return jsonify({
            "success": False,
            "message": "Could not save the connection preference.",
        }), 500

    response = jsonify({
        "success": True,
        "message": "RTSP connection enabled. Connecting to camera...",
    })
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/api/admin/camera-disconnect", methods=["POST"])
@login_required
def admin_camera_disconnect():
    stopped = rtsp_manager.disconnect()

    if not stopped:
        return jsonify({
            "success": False,
            "message": (
                "The camera reader has not stopped cleanly. "
                "Check the Flask logs before reconnecting."
            ),
        }), 500

    response = jsonify({
        "success": True,
        "message": "RTSP camera disconnected.",
    })
    response.headers["Cache-Control"] = "no-store"
    return response



@app.route("/api/simulator", methods=["POST"])
@login_required
def simulator_control():
    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({
            "error": "A JSON request body is required."
        }), 400

    connected = data.get("connected")

    if not isinstance(connected, bool):
        return jsonify({
            "error": "'connected' must be true or false."
        }), 400

    previous_state = camera_state["connected"]
    camera_state["connected"] = connected

    try:
        save_camera_state(camera_state)
    except OSError:
        camera_state["connected"] = previous_state
        app.logger.exception("Failed to persist simulator state.")
        return jsonify({
            "error": "Could not save simulator state."
        }), 500

    return jsonify({
        "connected": camera_state["connected"],
        "mode": "simulator",
    }), 200


@app.route("/api/admin/camera-config", methods=["GET"])
@login_required
def get_camera_config():
    response = jsonify(config_for_browser())
    response.headers["Cache-Control"] = "no-store"
    return response



@app.route("/api/admin/camera-config", methods=["POST"])
@login_required
def update_camera_config():
    global camera_config

    data = request.form if request.form else (
        request.get_json(silent=True) or {}
    )

    if not hasattr(data, "get"):
        return jsonify({
            "error": "A valid configuration payload is required."
        }), 400

    name = str(data.get("camera_name", "Entrance")).strip()
    host = str(data.get("camera_host", "")).strip()
    username = str(data.get("username", "")).strip()
    password = str(data.get("password", ""))

    custom_url = str(data.get("custom_rtsp_url", "")).strip()
    requested_mode = str(data.get("connection_mode", "")).strip().lower()
    stream = str(data.get("stream", "main")).strip().lower()

    # Backward compatibility for older clients that don't send the mode.
    if not requested_mode:
        if custom_url:
            requested_mode = "custom"
        else:
            requested_mode = stream

    if requested_mode not in {"main", "sub", "custom"}:
        return jsonify({
            "error": "Select Main Stream, Substream, or Custom RTSP URL."
        }), 400

    notice = str(
        data.get(
            "notice_text",
            "VIDEO SURVEILLANCE IN PROGRESS",
        )
    ).strip()

    try:
        port = int(data.get("rtsp_port", 554))
    except (TypeError, ValueError):
        return jsonify({
            "error": "RTSP port must be a number between 1 and 65535."
        }), 400

    if not name or len(name) > 80:
        return jsonify({
            "error": "Camera name is required and must be 80 characters or fewer."
        }), 400

    if not 1 <= port <= 65535:
        return jsonify({
            "error": "RTSP port must be between 1 and 65535."
        }), 400

    if (
        len(host) > 255
        or len(username) > 128
        or len(password) > 512
        or len(notice) > 200
        or len(custom_url) > 2048
    ):
        return jsonify({
            "error": "One or more fields exceed the allowed length."
        }), 400

    # For custom mode, validate the URL and extract any embedded credentials.
    if requested_mode == "custom":
        if not custom_url:
            return jsonify({
                "error": "Enter a Custom RTSP URL."
            }), 400

        try:
            parts = urlsplit(custom_url)

            if (
                parts.scheme.lower() not in {"rtsp", "rtsps"}
                or not parts.hostname
            ):
                raise ValueError("Invalid RTSP URL.")

            # Accessing .port validates malformed and out-of-range ports.
            url_port = parts.port

            if url_port is not None and not 1 <= url_port <= 65535:
                raise ValueError("Invalid RTSP port.")

            # If credentials are embedded in the URL, extract them.
            if parts.username is not None:
                username = unquote(parts.username)

                if parts.password is not None:
                    password = unquote(parts.password)

            if len(username) > 128 or len(password) > 512:
                return jsonify({
                    "error": "The RTSP credentials exceed the allowed length."
                }), 400

            # Remove credentials from the URL before saving it.
            hostname = parts.hostname

            if ":" in hostname and not hostname.startswith("["):
                hostname = f"[{hostname}]"

            netloc = hostname

            if url_port is not None:
                netloc += f":{url_port}"

            custom_url = urlunsplit(
                parts._replace(netloc=netloc)
            )

        except ValueError:
            return jsonify({
                "error": (
                    "Enter a valid RTSP URL with a valid hostname "
                    "and port."
                )
            }), 400

    else:
        # Main and substream modes must not retain an old custom URL.
        custom_url = ""
        stream = requested_mode

    new_config = camera_config.copy()

    new_config.update({
        "camera_name": name,
        "connection_mode": requested_mode,
        "camera_host": host,
        "rtsp_port": port,
        "username": username,
        "stream": stream,
        "custom_rtsp_url": custom_url,
        "notice_text": notice or "VIDEO SURVEILLANCE IN PROGRESS",
    })

    # An empty password field keeps the previously saved password.
    if password:
        new_config["password"] = password

    upload = request.files.get("logo")

    if upload and upload.filename:
        original_name = secure_filename(upload.filename)
        extension = (
            original_name.rsplit(".", 1)[-1].lower()
            if "." in original_name
            else ""
        )

        if extension not in ALLOWED_LOGO_EXTENSIONS:
            return jsonify({
                "error": "Logo must be PNG, JPG, JPEG, or WebP."
            }), 400

        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

        # Use a fixed filename to avoid trusting uploaded paths.
        logo_name = "store-logo." + extension
        upload_path = UPLOAD_DIR / logo_name

        upload.save(upload_path)

        try:
            os.chmod(upload_path, 0o644)
        except OSError:
            pass

        new_config["logo_path"] = "/static/uploads/" + logo_name

    remove_logo = data.get("remove_logo") in ("true", "1", True)

    if remove_logo:
        old_logo = new_config.get("logo_path", "")

        if old_logo.startswith("/static/uploads/"):
            old_path = BASE_DIR / old_logo.lstrip("/")

            try:
                old_path.unlink(missing_ok=True)
            except OSError:
                app.logger.warning(
                    "Could not remove the previous logo file."
                )

        new_config["logo_path"] = ""

    try:
        save_camera_config(new_config)
    except OSError:
        app.logger.exception(
            "Failed to persist camera configuration."
        )
        return jsonify({
            "error": "Could not save camera configuration."
        }), 500

    camera_config = new_config

    if requested_mode == "custom":
        has_rtsp_config = bool(custom_url)
    else:
        has_rtsp_config = bool(host)

    # Apply the new configuration if auto-connect is enabled,
    # or if an RTSP stream is already active.
    should_apply_config = (
        rtsp_manager.enabled or rtsp_stream.running
    )

    if should_apply_config:
        if has_rtsp_config:
            if not rtsp_stream.start(camera_config):
                app.logger.warning(
                    "Saved camera settings, but the RTSP stream "
                    "could not be restarted: %s",
                    rtsp_stream.last_error,
                )
        elif rtsp_stream.running:
            if not rtsp_stream.stop():
                app.logger.warning(
                    "Could not stop the RTSP stream after "
                    "saving the configuration."
                )

    response = jsonify({
        "success": True,
        "message": "Camera configuration saved.",
        "camera_name": camera_config["camera_name"],
        "logo_path": camera_config["logo_path"],
        "password_configured": bool(camera_config.get("password")),
        "mode": "rtsp" if has_rtsp_config else "simulator",
    })

    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/api/admin/test-connection", methods=["POST"])
@login_required
def test_camera_connection():
    if not camera_config.get("custom_rtsp_url") and not camera_config.get("camera_host"):
        connected = bool(camera_state["connected"])
        return jsonify({
            "success": connected,
            "mode": "simulator",
            "connected": connected,
            "message": (
                "Simulator test passed."
                if connected else "Simulator is disconnected."
            ),
            "physical_camera_tested": False,
        }), 200

    if not rtsp_stream.start(camera_config):
        return jsonify({
            "success": False,
            "mode": "rtsp",
            "connected": False,
            "message": rtsp_stream.last_error,
        }), 200

    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        status = rtsp_stream.status()
        if status["connected"]:
            return jsonify({
                "success": True,
                "mode": "rtsp",
                "connected": True,
                "message": "RTSP stream connected successfully.",
            }), 200
        time.sleep(0.2)

    rtsp_stream.stop()
    return jsonify({
        "success": False,
        "mode": "rtsp",
        "connected": False,
        "message": "No video frames received from the RTSP stream.",
    }), 200



@app.route("/camera-feed.mjpg")
def camera_feed():
    def generate():
        while True:
            frame = rtsp_stream.get_frame()

            if frame is None:
                if not rtsp_stream.running:
                    break
                time.sleep(0.1)
                continue

            ok, encoded = cv2.imencode(
                ".jpg",
                frame,
                [cv2.IMWRITE_JPEG_QUALITY, 80],
            )
            if not ok:
                continue

            yield (
                b"--frame\r\n"
                b"Content-Type: image/jpeg\r\n\r\n"
                + encoded.tobytes()
                + b"\r\n"
            )
            time.sleep(0.03)

    if not rtsp_stream.running:
        abort(503)

    response = Response(
        stream_with_context(generate()),
        mimetype="multipart/x-mixed-replace; boundary=frame",
    )
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response



if __name__ == "__main__":
    # Local development only. Use a production WSGI server for deployment.
    debug_mode = True

    # Start the manager only in Flask's serving process,
    # not in the debug reloader's parent process.
    if (
        not debug_mode
        or os.environ.get("WERKZEUG_RUN_MAIN") == "true"
    ):
        if camera_config.get("rtsp_autoconnect", True):
            rtsp_manager.start()

    app.run(
        host="127.0.0.1",
        port=8080,
        debug=debug_mode,
    )

