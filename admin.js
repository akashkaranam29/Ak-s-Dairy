const ADMIN_SESSION_KEY = 'aks-dairy-admin-session-v1';
let adminToken = sessionStorage.getItem(ADMIN_SESSION_KEY) || '';
let searchTimer;
const byId = (id) => document.getElementById(id);
const today = new Date();
const localToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const rupees = (amount) => `₹${Number(amount || 0).toLocaleString('en-IN')}`;
const statusNames = { placed: 'Awaiting review', approved: 'Approved', disapproved: 'Declined', packed: 'Packed', delivered: 'Delivered' };

function setLoggedIn(signedIn) {
  byId('admin-login-panel').hidden = signedIn;
  byId('admin-dashboard').hidden = !signedIn;
  byId('admin-logout').hidden = !signedIn;
  byId('manage-store-button').hidden = !signedIn;
  byId('store-toggle').hidden = !signedIn;
  byId('admin-orders-view').hidden = !signedIn || storeViewOpen;
  byId('admin-store-view').hidden = !signedIn || !storeViewOpen;
}

let storeViewOpen = false;

async function request(path, options = {}) {
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(adminToken ? { Authorization: `Bearer ${adminToken}` } : {}), ...options.headers },
    });
  } catch {
    throw new Error('The dairy database is unavailable. On this computer, start Ak’s Dairy with “Start Ak’s Dairy.bat”.');
  }
  let result;
  try { result = await response.json(); } catch { throw new Error('The admin service could not read its database response.'); }
  if (!response.ok) throw new Error(result.error || 'That request could not be completed.');
  return result;
}

function makeMeta(text) {
  const span = document.createElement('span');
  span.textContent = text;
  return span;
}

function setStoreStatus(isOpen) {
  const toggle = byId('store-toggle');
  toggle.classList.toggle('is-open', isOpen);
  toggle.classList.toggle('is-closed', !isOpen);
  toggle.setAttribute('aria-checked', String(isOpen));
  byId('store-toggle-label').textContent = isOpen ? 'Shop is open' : 'Shop is closed';
}

function drawOrder(order) {
  const card = document.createElement('article');
  card.className = 'admin-order';
  const top = document.createElement('div');
  top.className = 'admin-order-top';
  const idBlock = document.createElement('div');
  idBlock.className = 'admin-order-id';
  const idLabel = document.createElement('small');
  idLabel.textContent = 'UNIQUE ORDER ID';
  const idText = document.createElement('strong');
  idText.textContent = order.id;
  idBlock.append(idLabel, idText);
  const badge = document.createElement('span');
  badge.className = `admin-badge ${order.status}`;
  badge.textContent = statusNames[order.status] || order.status;
  top.append(idBlock, badge);

  const meta = document.createElement('div');
  meta.className = 'admin-order-meta';
  meta.append(makeMeta(order.customer.name), makeMeta(order.customer.phone), makeMeta(new Date(order.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })), makeMeta(order.paymentMethod));
  const address = document.createElement('div');
  address.className = 'admin-order-meta';
  address.append(makeMeta(`Deliver to: ${order.customer.address}`));

  const list = document.createElement('ul');
  list.className = 'admin-order-items';
  order.items.forEach((item) => {
    const row = document.createElement('li');
    row.append(makeMeta(`${item.quantity} × ${item.name}`), makeMeta(rupees(item.quantity * item.price)));
    list.append(row);
  });
  const bottom = document.createElement('div');
  bottom.className = 'admin-order-bottom';
  const total = document.createElement('strong');
  total.className = 'admin-order-total';
  total.textContent = `Order total · ${rupees(order.total)}`;
  const actions = document.createElement('div');
  actions.className = 'admin-order-actions';
  const addAction = (label, status, danger = false) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `admin-action${danger ? ' danger' : ''}`;
    button.textContent = label;
    button.addEventListener('click', () => updateStatus(order.id, status, button));
    actions.append(button);
  };
  if (order.status === 'placed') { addAction('Approve order', 'approved'); addAction('Decline order', 'disapproved', true); }
  else if (order.status === 'approved') addAction('Mark as packed', 'packed');
  else if (order.status === 'packed') addAction('Mark as delivered', 'delivered');
  bottom.append(total, actions);
  card.append(top, meta, address, list, bottom);
  return card;
}

async function loadOrders() {
  if (!adminToken) return;
  const date = byId('orders-date').value || localToday;
  const search = byId('order-search').value.trim();
  try {
    const query = new URLSearchParams({ date, search });
    const result = await request(`/api/admin/orders?${query}`);
    setStoreStatus(Boolean(result.storeOpen));
    byId('day-order-count').textContent = Number(result.summary.count).toLocaleString('en-IN');
    byId('day-earnings').textContent = rupees(result.summary.earnings);
    byId('live-order-count').textContent = Number(result.summary.liveCount).toLocaleString('en-IN');
    byId('orders-period-label').textContent = search ? `Search results for “${search}”` : `Orders received on ${new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', { dateStyle: 'long' })}`;
    const list = byId('admin-orders-list');
    list.replaceChildren();
    if (!result.orders.length) {
      const empty = document.createElement('div');
      empty.className = 'admin-empty';
      empty.textContent = search ? 'No order matches that ID. Check the letters and numbers and try again.' : 'No orders were placed on this day.';
      list.append(empty);
    } else result.orders.forEach((order) => list.append(drawOrder(order)));
    byId('admin-feedback').textContent = '';
  } catch (error) {
    if (error.message.includes('Admin sign-in')) {
      sessionStorage.removeItem(ADMIN_SESSION_KEY);
      adminToken = '';
      setLoggedIn(false);
    }
    byId('admin-feedback').textContent = error.message;
  }
}

async function updateStatus(orderId, status, button) {
  button.disabled = true;
  try {
    await request('/api/admin/order-status', { method: 'POST', body: JSON.stringify({ orderId, status }) });
    byId('admin-feedback').textContent = `Order ${orderId} updated to ${statusNames[status]}.`;
    await loadOrders();
  } catch (error) {
    byId('admin-feedback').textContent = error.message;
    button.disabled = false;
  }
}

function resetProductForm() {
  byId('product-form').reset();
  byId('product-id').value = '';
  byId('product-image-data').value = '';
  byId('product-image-preview').removeAttribute('src');
  byId('product-image-preview').hidden = true;
  byId('product-form-title').textContent = 'Add a product';
  byId('product-form-message').textContent = '';
  byId('product-form').hidden = true;
}

function drawProduct(product) {
  const card = document.createElement('article');
  card.className = `managed-product${Number(product.active) ? '' : ' inactive'}`;
  const photo = document.createElement('div');
  photo.className = 'managed-product-photo';
  if (product.image_data) {
    const img = document.createElement('img');
    img.src = product.image_data;
    img.alt = '';
    photo.append(img);
  } else {
    photo.classList.add(`photo-${product.category}`);
    photo.textContent = product.name.slice(0, 1).toLocaleUpperCase();
  }
  const details = document.createElement('div');
  details.className = 'managed-product-details';
  const name = document.createElement('strong');
  name.textContent = product.name;
  const description = document.createElement('p');
  description.textContent = product.description;
  const meta = document.createElement('small');
  meta.textContent = `${rupees(product.price)} / ${product.unit}  ·  Stock: ${product.quantity}`;
  const state = document.createElement('span');
  state.className = `managed-product-state${Number(product.active) ? '' : ' removed'}`;
  state.textContent = Number(product.active) ? (Number(product.quantity) ? 'In consumer store' : 'Out of stock') : 'Removed from store';
  details.append(name, description, meta, state);
  const actions = document.createElement('div');
  actions.className = 'managed-product-actions';
  const edit = document.createElement('button');
  edit.type = 'button'; edit.className = 'admin-action'; edit.textContent = Number(product.active) ? 'Edit' : 'Restore / edit';
  edit.addEventListener('click', () => editProduct(product));
  actions.append(edit);
  if (Number(product.active)) {
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'admin-action danger'; remove.textContent = 'Remove';
    remove.addEventListener('click', () => removeProduct(product, remove));
    actions.append(remove);
  }
  card.append(photo, details, actions);
  return card;
}

async function loadStoreProducts() {
  const list = byId('managed-products-list');
  try {
    const { products } = await request('/api/products?manage=1');
    list.replaceChildren();
    if (!products.length) {
      const empty = document.createElement('div');
      empty.className = 'admin-empty';
      empty.textContent = 'Your store is ready for its first product.';
      list.append(empty);
    } else products.forEach((product) => list.append(drawProduct(product)));
  } catch (error) { byId('store-feedback').textContent = error.message; }
}

function editProduct(product) {
  const form = byId('product-form');
  form.reset();
  byId('product-id').value = product.id;
  byId('product-name').value = product.name;
  byId('product-description').value = product.description;
  byId('product-price').value = product.price;
  byId('product-unit').value = product.unit;
  byId('product-quantity').value = product.quantity;
  byId('product-category').value = product.category;
  byId('product-image-data').value = product.image_data || '';
  byId('product-image-file').value = '';
  const preview = byId('product-image-preview');
  preview.hidden = !product.image_data;
  if (product.image_data) preview.src = product.image_data;
  byId('product-form-title').textContent = Number(product.active) ? 'Update product' : 'Restore and update product';
  byId('product-form-message').textContent = '';
  form.hidden = false;
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function imageAsDataUrl(file) {
  if (!file.type.startsWith('image/')) throw new Error('Choose an image file.');
  if (file.size > 12 * 1024 * 1024) throw new Error('Choose an image smaller than 12 MB.');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1000 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/webp', 0.78);
}

async function removeProduct(product, button) {
  if (!window.confirm(`Remove ${product.name} from the consumer store?`)) return;
  button.disabled = true;
  try {
    await request('/api/products', { method: 'DELETE', body: JSON.stringify({ id: product.id }) });
    byId('store-feedback').textContent = `${product.name} was removed from the consumer store.`;
    await loadStoreProducts();
  } catch (error) { byId('store-feedback').textContent = error.message; button.disabled = false; }
}

byId('orders-date').value = localToday;
byId('admin-login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = byId('admin-login-message');
  message.textContent = '';
  try {
    const result = await request('/api/admin-login', {
      method: 'POST',
      body: JSON.stringify({ mobile: byId('admin-mobile').value, password: byId('admin-password').value }),
    });
    adminToken = result.token;
    sessionStorage.setItem(ADMIN_SESSION_KEY, adminToken);
    setLoggedIn(true);
    await loadOrders();
  } catch (error) { message.textContent = error.message; }
});
byId('admin-logout').addEventListener('click', async () => {
  try { await request('/api/admin/logout', { method: 'POST', body: '{}' }); } catch { /* Clear this device's admin session even when offline. */ }
  adminToken = '';
  sessionStorage.removeItem(ADMIN_SESSION_KEY);
  storeViewOpen = false;
  byId('manage-store-button').textContent = 'Manage store';
  setLoggedIn(false);
});
byId('store-toggle').addEventListener('click', async () => {
  const toggle = byId('store-toggle');
  toggle.disabled = true;
  const nextOpen = toggle.getAttribute('aria-checked') !== 'true';
  try {
    const result = await request('/api/products', {
      method: 'POST',
      body: JSON.stringify({ action: 'set-store-status', isOpen: nextOpen }),
    });
    setStoreStatus(Boolean(result.storeOpen));
    (storeViewOpen ? byId('store-feedback') : byId('admin-feedback')).textContent = result.storeOpen
      ? 'The shop is open. Customers can place orders.'
      : 'The shop is closed. Customer checkout is paused.';
  } catch (error) {
    byId('admin-feedback').textContent = error.message;
  } finally { toggle.disabled = false; }
});
byId('orders-date').addEventListener('change', loadOrders);
byId('order-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadOrders, 250);
});
byId('manage-store-button').addEventListener('click', async () => {
  storeViewOpen = !storeViewOpen;
  byId('manage-store-button').textContent = storeViewOpen ? '← Back to orders' : 'Manage store';
  setLoggedIn(true);
  if (storeViewOpen) await loadStoreProducts();
});
byId('add-product-button').addEventListener('click', () => {
  resetProductForm();
  byId('product-form').hidden = false;
  byId('product-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  byId('product-name').focus();
});
byId('cancel-product-edit').addEventListener('click', resetProductForm);
byId('cancel-product-edit-bottom').addEventListener('click', resetProductForm);
byId('product-image-file').addEventListener('change', async (event) => {
  const file = event.currentTarget.files?.[0];
  if (!file) return;
  const message = byId('product-form-message');
  try {
    byId('product-image-data').value = await imageAsDataUrl(file);
    const preview = byId('product-image-preview');
    preview.src = byId('product-image-data').value;
    preview.hidden = false;
    message.textContent = 'Product photo is ready to save.';
  } catch (error) { message.textContent = error.message || 'We couldn’t read that image.'; }
});
byId('product-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = byId('product-form-message');
  const payload = {
    id: byId('product-id').value,
    name: byId('product-name').value.trim(),
    description: byId('product-description').value.trim(),
    price: byId('product-price').value,
    unit: byId('product-unit').value.trim(),
    quantity: byId('product-quantity').value,
    category: byId('product-category').value,
    imageData: byId('product-image-data').value,
  };
  try {
    await request('/api/products', { method: 'POST', body: JSON.stringify(payload) });
    message.textContent = 'Product saved. The consumer store is updated.';
    resetProductForm();
    byId('store-feedback').textContent = 'Product saved to the consumer store.';
    await loadStoreProducts();
  } catch (error) { message.textContent = error.message; }
});
if (adminToken) { setLoggedIn(true); loadOrders(); }
setInterval(loadOrders, 15000);
