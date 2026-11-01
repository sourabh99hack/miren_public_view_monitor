
document.addEventListener("DOMContentLoaded", () => {
    const passwordInput = document.getElementById("password");
    const loginForm = document.querySelector(".login-card form");

    if (passwordInput) {
        passwordInput.focus();
    }

    if (loginForm) {
        loginForm.addEventListener("submit", () => {
            const button = loginForm.querySelector('button[type="submit"]');

            if (button) {
                button.disabled = true;
                button.textContent = "Signing in...";
            }
        });
    }
});
