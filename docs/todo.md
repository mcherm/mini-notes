# Things to do
* Able to run offline (cache things in the service worker).
* Do a destroy when offline and it shows an error BUT also removes it from the UI.
* Need to make sure that when things go offline then something WORKS we go ahead and immediately push the queue (maybe still scheduled to happen?)
* Fix the annoying behavior that Chrome and Safari seem to think the search box is a password box and offer to save the password or populate it.
* Run clippy and fix all issues. Add a just command for it and a validator for JavaScript.
* Works offline (Firefox, iOS support missing)
* Go through .js files and find duplicated code. Extract to a common file.
* The "test" directory is JUST tests of the javascript. Move or rename accordingly.
* Search within a note
* Support for "log out of all devices" (ask when clicking "logout").
* Move lengthy content in justfile to a ./scripts directory
* The way data-layer.js publishes an object that wraps all API calls is clean and elegant. Make the system do that ALSO for requests that do NOT go through the caching layer (but don't mix them).
* Add documentation about use of AI in writing it.
