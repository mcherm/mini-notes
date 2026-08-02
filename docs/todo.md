# Things to do
* Able to run offline (cache things in the service worker).
* Run clippy and fix all issues. Add a just command for it and a validator for JavaScript.
* Works offline (Firefox, iOS support missing)
* Go through .js files and find duplicated code. Extract to a common file.
* Search within a note
* Support for "log out of all devices" (ask when clicking "logout").
* Move lengthy content in justfile to a ./scripts directory
* The way data-layer.js publishes an object that wraps all API calls is clean and elegant. Make the system do that ALSO for requests that do NOT go through the caching layer (but don't mix them).
