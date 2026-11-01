const video = document.getElementById("camera-video");
const cameraFeed = document.getElementById("camera-feed");
const liveIndicator = document.getElementById("live-indicator");
const offlineScreen = document.getElementById("offline-screen");
const footer = document.querySelector(".footer");
const copyright = document.querySelector(".copyright");

const storeLogo = document.getElementById("store-logo");
const defaultBrand = document.getElementById("default-brand");

const noticeContainer = document.getElementById(
    "display-notice-container"
);
const noticeText = document.getElementById("display-notice");

let currentMode = null;
let lastLogoPath = null;

function showOffline(message) {
    offlineScreen.classList.remove("hidden");
    offlineScreen.querySelector("p").textContent = message;

    liveIndicator.classList.add("hidden");
    video.classList.add("hidden");
    cameraFeed.classList.add("hidden");

    footer.classList.add("hidden");
    copyright.classList.remove("hidden");

    if (!video.paused) {
        video.pause();
    }

    cameraFeed.removeAttribute("src");
}

function showLive() {
    offlineScreen.classList.add("hidden");
    liveIndicator.classList.remove("hidden");

    footer.classList.remove("hidden");
    copyright.classList.remove("hidden");
}

function setLogo(path) {
    const logoPath = (path || "").trim();

    if (!logoPath) {
        storeLogo.classList.add("hidden");
        storeLogo.removeAttribute("src");

        defaultBrand.classList.remove("hidden");
        lastLogoPath = null;
        return;
    }

    defaultBrand.classList.add("hidden");

    if (logoPath !== lastLogoPath) {
        const separator = logoPath.includes("?") ? "&" : "?";

        storeLogo.src =
            `${logoPath}${separator}t=${Date.now()}`;

        lastLogoPath = logoPath;
    }

    storeLogo.classList.remove("hidden");
}

async function refreshDisplayConfig() {
    try {
        const response = await fetch(
            "/api/public-display-config",
            { cache: "no-store" }
        );

        if (!response.ok) {
            throw new Error(
                `Display config returned ${response.status}`
            );
        }

        const config = await response.json();

        // Show the logo saved through the Admin portal.
        setLogo(config.logo_path);

        // Display the saved notice.
        const footerText = document.getElementById("surveillance-notice");

if (footerText) {
    footerText.textContent = (
        config.notice_text || "VIDEO SURVEILLANCE IN PROGRESS"
    ).trim();
}

    } catch (error) {
        console.error(
            "Could not refresh display configuration:",
            error
        );
    }
}

async function refreshCameraStatus() {
    try {
        const response = await fetch(
            "/api/public-status",
            { cache: "no-store" }
        );

        if (!response.ok) {
            throw new Error(
                `Status API returned ${response.status}`
            );
        }

        const data = await response.json();

        if (!data.connected) {
            currentMode = data.mode || "simulator";

            showOffline(
                "Waiting for the camera connection..."
            );

            return;
        }

        showLive();

        const mode = data.mode || "simulator";

        if (mode === "rtsp") {
            // Use the live MJPEG stream.
            video.classList.add("hidden");

            if (!video.paused) {
                video.pause();
            }

            if (
                currentMode !== "rtsp" ||
                cameraFeed.classList.contains("hidden") ||
                !cameraFeed.hasAttribute("src")
            ) {
                cameraFeed.src =
                    `/camera-feed.mjpg?t=${Date.now()}`;
            }

            cameraFeed.classList.remove("hidden");

        } else {
            // Preserve the existing simulator video.
            cameraFeed.classList.add("hidden");
            cameraFeed.removeAttribute("src");

            video.classList.remove("hidden");

            if (video.paused) {
                try {
                    await video.play();
                } catch (error) {
                    console.error(
                        "Could not start simulator video:",
                        error
                    );

                    showOffline(
                        "Unable to start the demo video."
                    );
                }
            }
        }

        currentMode = mode;

    } catch (error) {
        console.error(
            "Camera status check failed:",
            error
        );

        showOffline(
            "Unable to check the camera connection."
        );
    }
}

cameraFeed.addEventListener("error", () => {
    console.error("Live camera feed could not be loaded.");

    showOffline(
        "Unable to load the live camera feed. Checking connection..."
    );

    currentMode = null;
});

video.addEventListener("error", () => {
    console.error(
        "Simulator video playback error:",
        video.error
    );

    showOffline("Unable to play the demo video.");
});

// Load settings and camera status.
refreshDisplayConfig();
refreshCameraStatus();

// Refresh the logo and notice if settings change in Admin.
setInterval(refreshDisplayConfig, 5000);

// Check the camera connection.
setInterval(refreshCameraStatus, 2000);
