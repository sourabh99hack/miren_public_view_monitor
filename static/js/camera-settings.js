document.addEventListener("DOMContentLoaded", () => {
    const form = document.getElementById("camera-settings-form");

    if (!form) {
        console.error("Camera settings form was not found.");
        return;
    }

    const messageBox = document.getElementById("camera-settings-message");
    const saveButton = document.getElementById("save-camera-settings-btn");
    const testButton = document.getElementById("test-camera-connection-btn");
    const resetButton = document.getElementById("reset-camera-settings-btn");

    const modeField = document.getElementById("connection_mode");
    const hostField = document.getElementById("camera_host");
    const portField = document.getElementById("rtsp_port");
    const usernameField = document.getElementById("username");
    const passwordField = document.getElementById("password");
    const streamField = document.getElementById("stream");
    const customUrlField = document.getElementById("custom_rtsp_url");

    const logoInput = document.getElementById("logo");
    const removeLogoCheckbox = document.getElementById("remove_logo");
    const logoPreviewContainer = document.getElementById(
        "camera-logo-preview-container"
    );
    const logoPreview = document.getElementById("camera-logo-preview");
    const passwordMessage = document.getElementById(
        "password-configured-message"
    );

    const csrfToken =
        document.querySelector('meta[name="csrf-token"]')
            ?.getAttribute("content") || "";

    let savedConfig = {};
    let originalLogoPath = "";
    let temporaryLogoUrl = null;
    let saveInProgress = false;
    let testInProgress = false;

    const defaultConfig = {
        camera_name: "Entrance Camera",
        camera_host: "",
        rtsp_port: 554,
        username: "",
        stream: "main",
        connection_mode: "main",
        custom_rtsp_url: "",
        notice_text: ""
    };

    // --------------------------------------------------
    // MESSAGES
    // --------------------------------------------------

    function showMessage(message, type = "info") {
        if (!messageBox) return;

        messageBox.textContent = message;
        messageBox.className = `settings-message ${type}`;
        messageBox.hidden = false;
    }

    function clearMessage() {
        if (!messageBox) return;

        messageBox.textContent = "";
        messageBox.hidden = true;
        messageBox.className = "settings-message";
    }

    // --------------------------------------------------
    // API REQUEST HELPER
    // --------------------------------------------------

    async function apiRequest(url, options = {}) {
        const headers = new Headers(options.headers || {});

        headers.set("Accept", "application/json");

        if (csrfToken) {
            headers.set("X-CSRFToken", csrfToken);
        }

        const response = await fetch(url, {
            ...options,
            headers,
            credentials: "same-origin",
            cache: "no-store"
        });

        const contentType = response.headers.get("content-type") || "";
        let data = {};

        if (contentType.includes("application/json")) {
            data = await response.json();
        } else {
            const responseText = await response.text();

            if (!response.ok) {
                throw new Error(
                    responseText || `Request failed (${response.status})`
                );
            }

            return { message: responseText };
        }

        if (!response.ok) {
            throw new Error(
                data.error ||
                data.message ||
                `Request failed (${response.status})`
            );
        }

        return data;
    }

    function extractConfig(data) {
        if (data.config && typeof data.config === "object") {
            return data.config;
        }

        return data;
    }

    // --------------------------------------------------
    // FORM HELPERS
    // --------------------------------------------------

    function setFieldValue(name, value) {
        const field = form.elements.namedItem(name);

        if (field && "value" in field) {
            field.value = value ?? "";
        }
    }

    function getFieldValue(name) {
        const field = form.elements.namedItem(name);

        return field && "value" in field ? field.value : "";
    }

    function getConnectionMode(config = {}) {
        const mode = config.connection_mode;

        if (["main", "sub", "custom"].includes(mode)) {
            return mode;
        }

        // Backward compatibility with configurations saved before
        // connection_mode was introduced.
        return String(config.custom_rtsp_url || "").trim()
            ? "custom"
            : config.stream === "sub"
                ? "sub"
                : "main";
    }

    function updateConnectionMode() {
        const mode = modeField?.value || "main";
        const isCustom = mode === "custom";

        // Host, port and credentials are edited in Main/Substream modes.
        [hostField, portField, usernameField, passwordField].forEach(
            (field) => {
                if (field) field.disabled = isCustom;
            }
        );

        if (streamField) {
            streamField.disabled = true;
        }

        if (customUrlField) {
            customUrlField.disabled = !isCustom;
            customUrlField.required = isCustom;
        }

        const customGroup = document.getElementById("custom-rtsp-group");
        const customHelp = document.getElementById("custom-rtsp-help");

        if (customGroup) {
            customGroup.classList.toggle("full-width", isCustom);
        }

        if (customHelp) {
            customHelp.textContent = isCustom
                ? "Paste the full RTSP URL. If it contains credentials, they will be separated from the displayed URL."
                : "Select Custom RTSP URL mode to edit a complete RTSP address.";
        }

        // The old stream field is retained for backend compatibility.
        if (streamField) {
            streamField.value = mode === "sub" ? "sub" : "main";
        }
    }

    // --------------------------------------------------
    // PARSE PASTED RTSP URL
    // --------------------------------------------------

    function parseCustomRtspUrl() {
        if (!customUrlField) return;

        const pastedUrl = customUrlField.value.trim();

        if (!pastedUrl) return;

        let parsed;

        try {
            parsed = new URL(pastedUrl);
        } catch {
            showMessage(
                "Enter a valid RTSP URL, for example rtsp://192.168.1.100:554/stream",
                "error"
            );
            return;
        }

        if (
            !["rtsp:", "rtsps:"].includes(parsed.protocol) ||
            !parsed.hostname
        ) {
            showMessage(
                "The URL must start with rtsp:// or rtsps:// and include a camera host.",
                "error"
            );
            return;
        }

        // URL.username and URL.password are percent-encoded.
        // Decode them before placing them into the separate fields.
        let parsedUsername = "";
        let parsedPassword = "";

        try {
            parsedUsername = decodeURIComponent(parsed.username);
            parsedPassword = decodeURIComponent(parsed.password);
        } catch {
            showMessage(
                "The URL contains invalid encoded credentials. Check the username and password.",
                "error"
            );
            return;
        }

        const hadCredentials = Boolean(
            parsed.username || parsed.password
        );

        // Populate connection fields from the URL.
        if (hostField) {
            hostField.value = parsed.hostname;
        }

        if (portField) {
            portField.value = parsed.port || "554";
        }

        if (hadCredentials) {
            if (usernameField) {
                usernameField.value = parsedUsername;
            }

            if (passwordField) {
                passwordField.value = parsedPassword;
            }
        }

        // Keep the full path and query, but remove credentials from the
        // visible URL. The backend must also sanitize URLs before saving.
        parsed.username = "";
        parsed.password = "";

        customUrlField.value = parsed.href;

        if (passwordMessage && hadCredentials) {
            passwordMessage.textContent =
                "A password was extracted from the pasted URL. Save settings to store it.";
        }

        showMessage(
            hadCredentials
                ? "RTSP URL parsed. Host, port and credentials were extracted; the URL displayed here has no credentials."
                : "RTSP URL parsed. Host and port were populated. No credentials were present in the URL.",
            "success"
        );
    }

    // --------------------------------------------------
    // POPULATE SETTINGS
    // --------------------------------------------------

    function populateForm(config) {
        const values = { ...defaultConfig, ...config };
        const mode = getConnectionMode(values);

        setFieldValue("camera_name", values.camera_name);
        setFieldValue("camera_host", values.camera_host);
        setFieldValue("rtsp_port", values.rtsp_port ?? "");
        setFieldValue("username", values.username);
        setFieldValue("password", "");
        setFieldValue("stream", values.stream || "main");
        setFieldValue("connection_mode", mode);
        setFieldValue("custom_rtsp_url", values.custom_rtsp_url);
        setFieldValue("notice_text", values.notice_text);

        updateConnectionMode();
    }

    function updatePasswordMessage(config, data = {}) {
        if (!passwordMessage) return;

        const configured =
            typeof data.password_configured === "boolean"
                ? data.password_configured
                : typeof config.password_configured === "boolean"
                    ? config.password_configured
                    : Boolean(config.password);

        passwordMessage.textContent = configured
            ? "A password is saved. Leave this field blank to keep it."
            : "No camera password has been saved.";
    }

    // --------------------------------------------------
    // LOGO PREVIEW
    // --------------------------------------------------

    function releaseTemporaryLogoUrl() {
        if (temporaryLogoUrl) {
            URL.revokeObjectURL(temporaryLogoUrl);
            temporaryLogoUrl = null;
        }
    }

    function setLogoPreview(path) {
        releaseTemporaryLogoUrl();
        originalLogoPath = path || "";

        if (!logoPreviewContainer || !logoPreview) return;

        if (!originalLogoPath) {
            logoPreviewContainer.hidden = true;
            logoPreview.removeAttribute("src");
            return;
        }

        logoPreview.src = originalLogoPath;
        logoPreviewContainer.hidden = false;
    }

    // --------------------------------------------------
    // LOAD SAVED SETTINGS
    // --------------------------------------------------

    async function loadSettings() {
        clearMessage();

        try {
            const data = await apiRequest("/api/admin/camera-config");
            const config = extractConfig(data);

            savedConfig = { ...config };

            populateForm(savedConfig);
            updatePasswordMessage(savedConfig, data);

            if (removeLogoCheckbox) {
                removeLogoCheckbox.checked = false;
            }

            setLogoPreview(savedConfig.logo_path || data.logo_path || "");

        } catch (error) {
            console.error("Unable to load camera settings:", error);

            showMessage(
                `Unable to load settings: ${error.message}`,
                "error"
            );
        }
    }

    // --------------------------------------------------
    // BUILD FORM DATA
    // --------------------------------------------------

    function buildFormData() {
        const formData = new FormData(form);
        const mode = modeField?.value || "main";
        const password = getFieldValue("password");

        // Disabled controls are omitted by FormData, so explicitly include
        // the connection fields needed by the backend.
        formData.set("connection_mode", mode);
        formData.set("stream", mode === "sub" ? "sub" : "main");
        formData.set("camera_host", getFieldValue("camera_host"));
        formData.set("rtsp_port", getFieldValue("rtsp_port"));
        formData.set("username", getFieldValue("username"));

        // Empty password means retain the saved password on the backend.
        if (password) {
            formData.set("password", password);
        } else {
            formData.delete("password");
        }

        formData.set(
            "custom_rtsp_url",
            mode === "custom" ? getFieldValue("custom_rtsp_url").trim() : ""
        );

        formData.set(
            "remove_logo",
            removeLogoCheckbox?.checked ? "true" : "false"
        );

        return formData;
    }

    // --------------------------------------------------
    // SAVE SETTINGS
    // --------------------------------------------------


    form.addEventListener("submit", async (event) => {
        event.preventDefault();

        if (saveInProgress) return;

        clearMessage();

        const mode = modeField?.value || "main";
        const host = getFieldValue("camera_host").trim();
        const portValue = getFieldValue("rtsp_port").trim();
        const customUrl = getFieldValue("custom_rtsp_url").trim();

        // --------------------------------------------------
        // VALIDATE CONNECTION SETTINGS
        // --------------------------------------------------

        if (mode === "custom") {
            if (!customUrl) {
                showMessage(
                    "Custom RTSP URL is required. Please enter the complete RTSP URL.",
                    "error"
                );
                customUrlField?.focus();
                return;
            }

            let parsedUrl;

            try {
                parsedUrl = new URL(customUrl);
            } catch {
                showMessage(
                    "Enter a valid RTSP URL, for example rtsp://192.168.1.100:554/stream",
                    "error"
                );
                customUrlField?.focus();
                return;
            }

            if (
                !["rtsp:", "rtsps:"].includes(parsedUrl.protocol) ||
                !parsedUrl.hostname
            ) {
                showMessage(
                    "The URL must start with rtsp:// or rtsps:// and include a valid camera host.",
                    "error"
                );
                customUrlField?.focus();
                return;
            }

            // Check the explicitly supplied URL port.
            if (parsedUrl.port) {
                const urlPort = Number(parsedUrl.port);

                if (
                    !Number.isInteger(urlPort) ||
                    urlPort < 1 ||
                    urlPort > 65535
                ) {
                    showMessage(
                        "The RTSP URL port must be between 1 and 65535.",
                        "error"
                    );
                    customUrlField?.focus();
                    return;
                }
            }
        } else {
            // Validate host.
            if (!host) {
                showMessage(
                    "Camera host is required. Enter the camera IP address or hostname.",
                    "error"
                );
                hostField?.focus();
                return;
            }

            // Validate port.
            const port = Number(portValue);

            if (
                !portValue ||
                !Number.isInteger(port) ||
                port < 1 ||
                port > 65535
            ) {
                showMessage(
                    "RTSP port is required. Enter a valid port between 1 and 65535.",
                    "error"
                );
                portField?.focus();
                return;
            }
        }

        // --------------------------------------------------
        // SAVE SETTINGS
        // --------------------------------------------------

        saveInProgress = true;

        if (saveButton) {
            saveButton.disabled = true;
            saveButton.textContent = "Saving...";
        }

        try {
            const data = await apiRequest(
                "/api/admin/camera-config",
                {
                    method: "POST",
                    body: buildFormData()
                }
            );

            const returnedConfig = extractConfig(data);

            savedConfig = {
                ...savedConfig,
                ...returnedConfig
            };

            // Update saved fields returned by the backend.
            [
                "camera_name",
                "camera_host",
                "rtsp_port",
                "username",
                "stream",
                "connection_mode",
                "custom_rtsp_url",
                "notice_text",
                "logo_path",
                "password_configured"
            ].forEach((key) => {
                if (data[key] !== undefined) {
                    savedConfig[key] = data[key];
                }
            });

            setFieldValue("password", "");
            updatePasswordMessage(savedConfig, data);

            // Update the logo preview.
            const returnedLogoPath =
                data.logo_path !== undefined
                    ? data.logo_path
                    : returnedConfig.logo_path;

            if (returnedLogoPath !== undefined) {
                setLogoPreview(returnedLogoPath);
            } else if (removeLogoCheckbox?.checked) {
                setLogoPreview("");
            } else if (logoInput?.files?.length) {
                await loadSettings();
            }

            if (removeLogoCheckbox) {
                removeLogoCheckbox.checked = false;
            }

            if (logoInput) {
                logoInput.value = "";
            }

            // Reload the latest saved configuration from the backend.
            await loadSettings();

            // Show success message after refreshing the form.
            showMessage(
                data.message || "Camera settings saved successfully.",
                "success"
            );

        } catch (error) {
            console.error("Unable to save camera settings:", error);

            showMessage(
                `Unable to save settings: ${error.message}`,
                "error"
            );

        } finally {
            saveInProgress = false;

            if (saveButton) {
                saveButton.disabled = false;
                saveButton.textContent = "Save Settings";
            }
        }
    });


    // --------------------------------------------------
    // CONNECTION MODE CHANGES
    // --------------------------------------------------

    modeField?.addEventListener("change", () => {
        updateConnectionMode();
        clearMessage();
    });

    // Parse the pasted URL when the user leaves the field or presses Enter.
    customUrlField?.addEventListener("change", () => {
        if (modeField?.value === "custom") {
            parseCustomRtspUrl();
        }
    });

    customUrlField?.addEventListener("paste", () => {
        // Wait until the pasted text has entered the input.
        setTimeout(() => {
            if (modeField?.value === "custom") {
                parseCustomRtspUrl();
            }
        }, 0);
    });

    // --------------------------------------------------
    // SELECT AND PREVIEW A LOGO
    // --------------------------------------------------

    if (logoInput) {
        logoInput.addEventListener("change", () => {
            clearMessage();

            const file = logoInput.files?.[0];

            releaseTemporaryLogoUrl();

            if (!file) {
                setLogoPreview(originalLogoPath);
                return;
            }

            const allowedTypes = [
                "image/png",
                "image/jpeg",
                "image/webp"
            ];

            if (!allowedTypes.includes(file.type)) {
                logoInput.value = "";
                setLogoPreview(originalLogoPath);

                showMessage(
                    "Choose a PNG, JPG, JPEG or WebP image.",
                    "error"
                );

                return;
            }

            if (file.size > 3 * 1024 * 1024) {
                logoInput.value = "";
                setLogoPreview(originalLogoPath);

                showMessage(
                    "The logo must be smaller than 3 MB.",
                    "error"
                );

                return;
            }

            temporaryLogoUrl = URL.createObjectURL(file);

            if (logoPreview) {
                logoPreview.src = temporaryLogoUrl;
            }

            if (logoPreviewContainer) {
                logoPreviewContainer.hidden = false;
            }

            if (removeLogoCheckbox) {
                removeLogoCheckbox.checked = false;
            }
        });
    }

    // --------------------------------------------------
    // REMOVE LOGO
    // --------------------------------------------------

    if (removeLogoCheckbox) {
        removeLogoCheckbox.addEventListener("change", () => {
            clearMessage();

            if (removeLogoCheckbox.checked) {
                if (logoInput) {
                    logoInput.value = "";
                }

                setLogoPreview("");
            } else {
                setLogoPreview(originalLogoPath);
            }
        });
    }

    // --------------------------------------------------
    // TEST CAMERA CONNECTION
    // --------------------------------------------------

    if (testButton) {
        testButton.addEventListener("click", async () => {
            if (testInProgress) return;

            clearMessage();

            testInProgress = true;
            testButton.disabled = true;
            testButton.textContent = "Testing...";

            try {
                const data = await apiRequest(
                    "/api/admin/test-connection",
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({})
                    }
                );

                if (data.physical_camera_tested === false) {
                    showMessage(
                        data.message ||
                        (
                            data.success
                                ? "Simulator test passed. No physical camera was tested."
                                : "Simulator test failed. Check the simulator connection."
                        ),
                        data.success ? "success" : "error"
                    );
                } else {
                    showMessage(
                        data.message || "Connection test completed.",
                        data.success ? "success" : "error"
                    );
                }

            } catch (error) {
                console.error("Connection test failed:", error);

                showMessage(
                    `Connection test failed: ${error.message}`,
                    "error"
                );

            } finally {
                testInProgress = false;
                testButton.disabled = false;
                testButton.textContent = "Test Connection";
            }
        });
    }


    // --------------------------------------------------
    // RESET FORM — TEMPORARY, CLIENT-SIDE ONLY
    // --------------------------------------------------

    if (resetButton) {
        resetButton.addEventListener("click", (event) => {
            event.preventDefault();

            // Reset the form to blank/default values.
            // This does NOT modify savedConfig or call the backend.
            populateForm({
                camera_name: "Entrance",
                connection_mode: "main",
                camera_host: "",
                rtsp_port: "",
                username: "",
                stream: "main",
                custom_rtsp_url: "",
                notice_text: ""
            });

            // Clear any unsaved password entry.
            setFieldValue("password", "");

            // Clear unsaved logo selection and removal request.
            if (logoInput) {
                logoInput.value = "";
            }

            if (removeLogoCheckbox) {
                removeLogoCheckbox.checked = true;
            }

            // Show the currently saved logo, if any.
            setLogoPreview("");

            updatePasswordMessage(savedConfig);
            clearMessage();
        });
    }


    // --------------------------------------------------
    // SCROLL TO CAMERA SETTINGS
    // --------------------------------------------------

    document
        .getElementById("scroll-to-camera-settings-btn")
        ?.addEventListener("click", () => {
            document
                .getElementById("camera-settings-section")
                ?.scrollIntoView({
                    behavior: "smooth",
                    block: "start"
                });
        });

    // Load saved settings when the page opens.
    loadSettings();
});
