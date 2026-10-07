app/ — the notes page (index.html) user interface

  state.js        the page's shared mutable state
  note-list.js    the note list: loading, rendering, scrolling, search, trash view
  note-editor.js  the note pane: display, saving, conflicts, undo/redo, note info,
                  and creating/deleting/recovering notes
  account.js      login, logout, and the user and forgot-password dialogs
  settings.js     the settings dialog, including import

Imported only by main.js (and each other). Modules here have no top-level side
effects; each exports a register…Listeners() function that main.js calls once
the DOM is loaded.
