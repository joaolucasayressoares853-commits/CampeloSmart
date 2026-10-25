(() => {
  'use strict';

  const DB_NAME = 'CampeloSmartDB';
  const DB_VERSION = 2;

  function openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('produtos')) db.createObjectStore('produtos', { keyPath: 'codigo' });
        if (!db.objectStoreNames.contains('carrinho')) db.createObjectStore('carrinho', { keyPath: 'id', autoIncrement: true });
        if (!db.objectStoreNames.contains('historico')) {
          const history = db.createObjectStore('historico', { keyPath: 'id' });
          history.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains('clientes')) {
          const customers = db.createObjectStore('clientes', { keyPath: 'identificador' });
          customers.createIndex('points', 'points');
        }
        if (!db.objectStoreNames.contains('preferencias')) db.createObjectStore('preferencias', { keyPath: 'chave' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function completeTransaction(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  function requestValue(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function run(storeName, mode, operation) {
    const db = await openDB();
    const transaction = db.transaction(storeName, mode);
    const result = await operation(transaction.objectStore(storeName), transaction);
    if (mode === 'readonly') await completeTransaction(transaction);
    db.close();
    return result;
  }

  async function saveProducts(products) {
    const db = await openDB();
    const transaction = db.transaction('produtos', 'readwrite');
    const store = transaction.objectStore('produtos');
    for (const product of products) {
      const current = await requestValue(store.get(product.codigo));
      store.put({ ...product, estoque: current?.estoque ?? product.estoque ?? 20 });
    }
    await completeTransaction(transaction);
    db.close();
  }

  const getProduct = code => run('produtos', 'readonly', store => requestValue(store.get(String(code))));
  const listProducts = () => run('produtos', 'readonly', store => requestValue(store.getAll()));
  const listCart = () => run('carrinho', 'readonly', store => requestValue(store.getAll()));

  async function clearCart() {
    const db = await openDB();
    const transaction = db.transaction('carrinho', 'readwrite');
    transaction.objectStore('carrinho').clear();
    await completeTransaction(transaction);
    db.close();
  }

  async function addCartItem(product) {
    if ((product.estoque ?? 20) <= 0) throw new Error('Produto sem estoque.');
    const db = await openDB();
    const transaction = db.transaction(['carrinho', 'produtos'], 'readwrite');
    const id = await requestValue(transaction.objectStore('carrinho').add({ ...product }));
    transaction.objectStore('produtos').put({ ...product, estoque: product.estoque - 1 });
    await completeTransaction(transaction);
    db.close();
    return id;
  }

  async function removeCartItem(id) {
    const db = await openDB();
    const transaction = db.transaction(['carrinho', 'produtos'], 'readwrite');
    const item = await requestValue(transaction.objectStore('carrinho').get(id));
    transaction.objectStore('carrinho').delete(id);
    if (item) {
      const product = await requestValue(transaction.objectStore('produtos').get(item.codigo));
      if (product) transaction.objectStore('produtos').put({ ...product, estoque: (product.estoque ?? 0) + 1 });
    }
    await completeTransaction(transaction);
    db.close();
  }

  async function saveSale(sale) {
    const db = await openDB();
    const transaction = db.transaction(['historico', 'clientes'], 'readwrite');
    const history = transaction.objectStore('historico');
    const customers = transaction.objectStore('clientes');
    history.put(sale);
    const existing = await requestValue(customers.get(sale.customer));
    const customer = {
      identificador: sale.customer,
      points: (existing?.points || 0) + sale.points,
      balance: (existing?.balance || 0) + sale.total,
      purchases: (existing?.purchases || 0) + 1,
      lifetimeValue: (existing?.lifetimeValue || 0) + sale.total,
      updatedAt: sale.createdAt
    };
    customers.put(customer);
    await completeTransaction(transaction);
    db.close();
    return customer;
  }

  const listSales = () => run('historico', 'readonly', store => requestValue(store.getAll()));
  const getCustomer = identifier => run('clientes', 'readonly', store => requestValue(store.get(identifier)));
  const setPreference = (key, value) => run('preferencias', 'readwrite', (store, transaction) => {
    store.put({ chave: key, value });
    return completeTransaction(transaction);
  });
  const getPreference = key => run('preferencias', 'readonly', store => requestValue(store.get(key)));

  async function exportDatabase() {
    const [produtos, historico, clientes, preferencias] = await Promise.all([
      listProducts(), listSales(), run('clientes', 'readonly', store => requestValue(store.getAll())),
      run('preferencias', 'readonly', store => requestValue(store.getAll()))
    ]);
    return { exportedAt: new Date().toISOString(), produtos, historico, clientes, preferencias };
  }

  window.db = {
    openDB, saveProducts, getProduct, listProducts, listCart, addCartItem, removeCartItem,
    clearCart, saveSale, listSales, getCustomer, setPreference, getPreference, exportDatabase
  };
})();
