lib/ — code shared by every page (index.html, admin.html, reset-password.html)

  api.js      backend URL, apiFetch, and reading error messages from responses
  alerts.js   inline-alerts, the floating-alert queue, and progress-boxes
  dialogs.js  shadow-box modals, and suppressing implicit form submission

Modules here hold no page-specific state and import nothing outside lib/.
Any page or module may import them.
