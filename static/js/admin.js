
document.addEventListener("DOMContentLoaded", () => {
    "use strict";

    // ==========================================
    // CURRENT ADMIN HTML ELEMENTS
    // ==========================================
    const cameraIndicator = document.getElementById("camera-status-indicator");
    const cameraStatusText = document.getElementById("camera-status-text");
    const cameraDescription = document.getElementById("camera-status-description");

    const connectButton = document.getElementById("connect-camera-btn");
    const disconnectButton = document.getElementById("disconnect-camera-btn");
    const openCameraStatusButton = document.getElementById("open-camera-status-btn");
    const openSystemHealthButton = document.getElementById("open-system-health-btn");

    const cameraStatusModal = document.getElementById("camera-status-modal");
    const cameraStatusModalBody = document.getElementById("camera-status-modal-body");

    const systemHealthModal = document.getElementById("system-health-modal");
    const systemHealthModalBody = document.getElementById("system-health-modal-body");

    const csrfToken =
        document.querySelector('meta[name="csrf-token"]')?.content || "";

    let requestInProgress = false;
    let healthRequestInProgress = false;
    let lastFocusedElement = null;
    let cameraRefreshTimer = null;
    let healthRefreshTimer = null;

    // ==========================================
    // HELPERS
    // ==========================================
    function currentTime() {
        return new Date().toLocaleString();
    }

    function setCameraStatus(connected, mode = "simulator") {
        if (cameraIndicator) {
            cameraIndicator.classList.remove(
                "connected", "disconnected", "online", "offline", "error"
            );
            cameraIndicator.classList.add(
                connected ? "connected" : "disconnected"
            );
        }

        if (cameraStatusText) {
            cameraStatusText.textContent =
                connected ? "Connected" : "Disconnected";
        }

        if (cameraDescription) {
    cameraDescription.textContent =
        mode === "rtsp"
            ? (
                connected
                    ? "The RTSP camera is connected and streaming video."
                    : "The RTSP camera is disconnected. Click Connect to retry."
            )
            : (
                connected
                    ? "The camera simulator reports an active connection."
                    : "The simulator is disconnected. Check the display's offline message."
            );
}
    }

    function setCameraUnavailable(errorMessage) {
        if (cameraIndicator) {
            cameraIndicator.classList.remove(
                "connected", "disconnected", "online", "offline"
            );
            cameraIndicator.classList.add("error");
        }

        if (cameraStatusText) {
            cameraStatusText.textContent = "Status unavailable";
        }

        if (cameraDescription) {
            cameraDescription.textContent = errorMessage;
        }
    }

    function setModalBody(modalBody, lines) {
        if (!modalBody) return;

        modalBody.replaceChildren();

        lines.forEach(([label, value]) => {
            const row = document.createElement("p");
            const strong = document.createElement("strong");
            const text = document.createElement("span");

            strong.textContent = `${label}: `;
            text.textContent = String(value ?? "—");

            row.append(strong, text);
            modalBody.appendChild(row);
        });
    }

    async function readJsonResponse(response) {
        const contentType = response.headers.get("content-type") || "";
        let data = {};

        if (contentType.includes("application/json")) {
            data = await response.json();
        } else {
            const text = await response.text();

            if (!response.ok) {
                throw new Error(
                    text || `Request failed with HTTP ${response.status}`
                );
            }

            throw new Error("The server returned an unexpected response.");
        }

        if (!response.ok) {
            throw new Error(
                data.error ||
                data.message ||
                `Request failed with HTTP ${response.status}`
            );
        }

        return data;
    }

    async function apiRequest(url, options = {}) {
        const headers = new Headers(options.headers || {});
        headers.set("Accept", "application/json");

        if (options.method === "POST" && csrfToken) {
            headers.set("X-CSRFToken", csrfToken);
        }

        const response = await fetch(url, {
            ...options,
            headers,
            credentials: "same-origin",
            cache: "no-store"
        });

        return readJsonResponse(response);
    }

    // ==========================================
    // CAMERA STATUS
    // ==========================================
    async function refreshCameraStatus() {
        try {
            const data = await apiRequest("/api/admin/camera-status");

            if (typeof data.connected !== "boolean") {
                throw new Error("The camera status response is invalid.");
            }

            setCameraStatus(data.connected, data.mode);

            if (
                cameraStatusModal &&
                !cameraStatusModal.hidden &&
                cameraStatusModalBody
            ) {
                setModalBody(cameraStatusModalBody, [
                    ["Connection", data.connected ? "Connected" : "Disconnected"],
                    ["Mode", data.mode || "Simulator"],
                    ["State file", data.state_file || "Server-managed"],
                    ["Last checked", currentTime()]
                ]);
            }
        } catch (error) {
            setCameraUnavailable(
                error.message || "Unable to retrieve camera status."
            );

            console.error("Camera status check failed:", error);
        }
    }

    // ==========================================
    // CONNECT / DISCONNECT SIMULATOR
    // ==========================================
    async function setSimulatorStatus(connected) {
        if (requestInProgress) return;

        requestInProgress = true;

        if (connectButton) connectButton.disabled = true;
        if (disconnectButton) disconnectButton.disabled = true;

        try {
            if (!csrfToken) {
                throw new Error(
                    "CSRF token is missing. Reload the admin page."
                );
            }

            const data = await apiRequest("/api/simulator", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({ connected })
            });

            if (typeof data.connected !== "boolean") {
                throw new Error("The simulator returned an invalid response.");
            }

            setCameraStatus(data.connected);
            await refreshCameraStatus();

        } catch (error) {
            setCameraUnavailable(
                error.message || "Unable to update simulator status."
            );

            console.error("Simulator update failed:", error);
        } finally {
            requestInProgress = false;

            if (connectButton) connectButton.disabled = false;
            if (disconnectButton) disconnectButton.disabled = false;
        }
    }

   
connectButton?.addEventListener("click", async () => {
    if (requestInProgress) return;

    requestInProgress = true;
    connectButton.disabled = true;
    if (disconnectButton) disconnectButton.disabled = true;

    try {
        if (!csrfToken) {
            throw new Error("CSRF token is missing. Refresh the page and try again.");
        }

        const data = await apiRequest("/api/admin/camera-connect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({})
        });

        if (!data.success) {
            throw new Error(data.message || "Unable to connect to the camera.");
        }

        await refreshCameraStatus();
    } catch (error) {
        setCameraUnavailable(error.message);
    } finally {
        requestInProgress = false;
        connectButton.disabled = false;
        if (disconnectButton) disconnectButton.disabled = false;
        await refreshCameraStatus().catch(() => {});
    }
});

disconnectButton?.addEventListener("click", async () => {
    if (requestInProgress) return;

    requestInProgress = true;
    disconnectButton.disabled = true;
    if (connectButton) connectButton.disabled = true;

    try {
        if (!csrfToken) {
            throw new Error("CSRF token is missing. Refresh the page and try again.");
        }

        const data = await apiRequest("/api/admin/camera-disconnect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({})
        });

        if (!data.success) {
            throw new Error(data.message || "Unable to disconnect the camera.");
        }

        await refreshCameraStatus();
    } catch (error) {
        setCameraUnavailable(error.message);
    } finally {
        requestInProgress = false;
        connectButton.disabled = false;
        disconnectButton.disabled = false;
        await refreshCameraStatus().catch(() => {});
    }
});

    // ==========================================
    // MODAL OPEN / CLOSE
    // ==========================================
    function openModal(modal, closeButton) {
        if (!modal) return;

        lastFocusedElement = document.activeElement;

        modal.hidden = false;
        modal.classList.add("is-open");
        modal.setAttribute("aria-hidden", "false");

        document.body.classList.add("modal-open");
        closeButton?.focus();
    }

    function closeModal(modal) {
        if (!modal) return;

        modal.classList.remove("is-open");
        modal.setAttribute("aria-hidden", "true");
        modal.hidden = true;

        const anotherModalOpen = [
            cameraStatusModal,
            systemHealthModal
        ].some(item => item && !item.hidden);

        if (!anotherModalOpen) {
            document.body.classList.remove("modal-open");
        }

        lastFocusedElement?.focus();
    }

    document.querySelectorAll("[data-close-modal]").forEach(button => {
        button.addEventListener("click", () => {
            const modalId = button.getAttribute("data-close-modal");
            closeModal(document.getElementById(modalId));
        });
    });

    // Support the backdrop IDs used by the earlier HTML version.
    document.querySelectorAll("[data-close-status-modal]").forEach(button => {
        button.addEventListener("click", () => closeModal(cameraStatusModal));
    });

    document.querySelectorAll("[data-close-health-modal]").forEach(button => {
        button.addEventListener("click", () => closeModal(systemHealthModal));
    });

    [cameraStatusModal, systemHealthModal].forEach(modal => {
        if (!modal) return;

        modal.addEventListener("click", event => {
            if (
                event.target === modal ||
                event.target.classList.contains("status-modal-backdrop")
            ) {
                closeModal(modal);
            }
        });
    });

    // ==========================================
    // CAMERA STATUS MODAL
    // ==========================================
    async function refreshCameraStatusModal() {
        if (!cameraStatusModalBody) return;

        cameraStatusModalBody.textContent = "Loading camera status...";

        try {
            const data = await apiRequest("/api/admin/camera-status");

            setModalBody(cameraStatusModalBody, [
                ["Connection", data.connected ? "Connected" : "Disconnected"],
                ["Mode", data.mode || "Simulator"],
                ["State file", data.state_file || "Server-managed"],
                ["Last checked", currentTime()]
            ]);
        } catch (error) {
            cameraStatusModalBody.textContent =
                error.message || "Unable to retrieve camera status.";

            console.error("Camera status modal failed:", error);
        }
    }

    openCameraStatusButton?.addEventListener("click", async () => {
        openModal(cameraStatusModal);
        await refreshCameraStatusModal();
    });

    // ==========================================
    // SYSTEM HEALTH
    // ==========================================
    function updateHealthCard(healthy, detail) {
        /*
         * Find the existing System Health card without requiring
         * additional IDs in admin.html.
         */
        const heading = Array.from(
            document.querySelectorAll("h2, h3, h4")
        ).find(element =>
            element.textContent.trim().toLowerCase() === "system health"
        );

        if (!heading) return;

        const card =
            heading.closest(".quick-card") ||
            heading.closest(".admin-card") ||
            heading.closest("section") ||
            heading.parentElement;

        if (!card) return;

        // Update the card's status text while keeping its existing layout.
        let statusText = card.querySelector("[data-health-status]");

        if (!statusText) {
            const description = card.querySelector("p");

            if (description) {
                statusText = description;
            }
        }

        if (statusText) {
            statusText.textContent = healthy
                ? `System is healthy. Last checked: ${new Date().toLocaleTimeString()}`
                : `System health unavailable: ${detail}`;
        }

        card.classList.toggle("healthy", healthy);
        card.classList.toggle("unhealthy", !healthy);
    }

    async function refreshSystemHealth() {
        if (healthRequestInProgress) return;

        healthRequestInProgress = true;

        if (systemHealthModalBody) {
            systemHealthModalBody.textContent = "Checking system health...";
        }

        try {
            const response = await fetch("/health", {
                method: "GET",
                credentials: "same-origin",
                cache: "no-store",
                headers: { Accept: "application/json" }
            });

            const data = await readJsonResponse(response);

            const status = String(
                data.status || data.health || data.message || ""
            ).toLowerCase();

            const healthy = status === "ok" || status === "healthy";

            const resultText = healthy
                ? "System Healthy"
                : `System status: ${data.status || data.message || "Unknown"}`;

            updateHealthCard(
                healthy,
                healthy ? "" : resultText
            );

            if (systemHealthModalBody) {
                setModalBody(systemHealthModalBody, [
                    ["Application", resultText],
                    ["HTTP response", `${response.status} ${response.statusText}`.trim()],
                    ["Service", data.service || data.service_name || "MiRen Monitor"],
                    ["Last checked", currentTime()]
                ]);
            }
        } catch (error) {
            updateHealthCard(false, error.message);

            if (systemHealthModalBody) {
                setModalBody(systemHealthModalBody, [
                    ["Application", "Unavailable"],
                    ["Error", error.message || "Unable to retrieve system health."],
                    ["Last checked", currentTime()]
                ]);
            }

            console.error("System health check failed:", error);
        } finally {
            healthRequestInProgress = false;
        }
    }

    openSystemHealthButton?.addEventListener("click", async () => {
        openModal(systemHealthModal);
        await refreshSystemHealth();
    });

    // Support refresh and close buttons from the modal HTML.
    document.getElementById("refresh-system-health")
        ?.addEventListener("click", refreshSystemHealth);

    document.getElementById("close-system-health")
        ?.addEventListener("click", () => closeModal(systemHealthModal));

    document.getElementById("close-system-health-footer")
        ?.addEventListener("click", () => closeModal(systemHealthModal));

    document.getElementById("refresh-camera-status")
        ?.addEventListener("click", refreshCameraStatusModal);

    document.getElementById("close-camera-status")
        ?.addEventListener("click", () => closeModal(cameraStatusModal));

    document.getElementById("close-camera-status-footer")
        ?.addEventListener("click", () => closeModal(cameraStatusModal));

    // ==========================================
    // KEYBOARD SUPPORT
    // ==========================================
    document.addEventListener("keydown", event => {
        if (event.key !== "Escape") return;

        if (cameraStatusModal && !cameraStatusModal.hidden) {
            closeModal(cameraStatusModal);
        }

        if (systemHealthModal && !systemHealthModal.hidden) {
            closeModal(systemHealthModal);
        }
    });

    // ==========================================
    // CONFIGURE CAMERA BUTTON
    // ==========================================
    document
        .getElementById("scroll-to-camera-settings-btn")
        ?.addEventListener("click", () => {
            document.getElementById("camera-settings-section")
                ?.scrollIntoView({
                    behavior: "smooth",
                    block: "start"
                });
        });

    // ==========================================
    // INITIAL STATUS + AUTOMATIC REFRESH
    // ==========================================
    refreshCameraStatus();
    refreshSystemHealth();

    cameraRefreshTimer = window.setInterval(
        refreshCameraStatus,
        5000
    );

    healthRefreshTimer = window.setInterval(
        refreshSystemHealth,
        10000
    );

    window.addEventListener("pagehide", () => {
        if (cameraRefreshTimer !== null) {
            window.clearInterval(cameraRefreshTimer);
        }

        if (healthRefreshTimer !== null) {
            window.clearInterval(healthRefreshTimer);
        }
    });
});
