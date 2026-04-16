"use strict";

/** Thrown by apiFetch when a 401 triggers logout, to abort the caller's flow. */
class LoggedOutError extends Error {
    constructor() { super("Session expired — logged out"); }
}

// ========== Constants ==========


// ========== Actions ==========

async function actionMeasureUsersBtn() {
    console.log("Measure users now!!"); // FIXME: Write real code
}

// ========== Initialization ==========

document.addEventListener("DOMContentLoaded", () => {
    document.querySelector("#measure-users-btn").addEventListener("click", actionMeasureUsersBtn);
});
