# Things to do
* Do a destroy when offline and it shows an error BUT also removes it from the UI.
* Run clippy and fix all issues. Add a just command for it and a validator for JavaScript.
* Go through .js files and find duplicated code. Extract to a common file.
* Merge the code for alert handling (showInlineAlert, clearInlineAlert and friends) and other duplicated code in main.js, admin.js and reset-password.js into a common file.
* The "test" directory is JUST tests of the javascript. Move or rename accordingly.
* Search within a note
* Support for "log out of all devices" (ask when clicking "logout").
* Move lengthy content in justfile to a ./scripts directory
* The way data-layer.js publishes an object that wraps all API calls is clean and elegant. Make the system do that ALSO for requests that do NOT go through the caching layer (but don't mix them).
* Known bug: when the server's response to a first-page note list load arrives after the user has edited the list (creating, editing, or deleting a note), the response is dropped and the list stays on the 100 cached notes, so the user cannot scroll past the first 100 notes until the next first-page load.
