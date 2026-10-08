data/ — reading and writing note data: the network, the local store, and sync

  data-layer.js      the dataLayer object: the one data-access interface used by
                     UI code, and the shapes of its results
  network-source.js  backend requests; NetworkDataSource, the online-only
                     implementation
  offline-source.js  OfflineDataSource, the implementation backed by the local
                     mirror and write queue
  store.js           the IndexedDB note store (mirror and queue)
  sync-engine.js     the single-tab engine that retries queued writes

No DOM. Modules here import from model/, lib/api.js and data/, and are tested
in js-tests/. See docs/pwa_design.md ("Note Data Caching").
