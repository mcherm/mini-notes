# Things to do
* Able to run offline (cache things in the service worker).
* Works offline (Firefox, iOS support missing)
* Go through .js files and find duplicated code. Extract to a common file.
* Search within a note
* Support for "log out of all devices" (ask when clicking "logout").
* Move lengthy content in justfile to a ./scripts directory
* Fix handle_delete_note: add a condition_expression so deleting a nonexistent note returns 404 instead of creating a phantom item (update_item creates the item when the key doesn't exist).
