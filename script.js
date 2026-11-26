const CART_KEY = 'aks-dairy-cart-v1';
const ORDERS_KEY = 'aks-dairy-orders-v1';
const PROFILE_KEY = 'aks-dairy-profile-v1';
const ACCOUNTS_KEY = 'aks-dairy-accounts-v1';
const SESSION_KEY = 'aks-dairy-session-v1';

function readSaved(key, fallback) {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
}

let cart = new Map(readSaved(CART_KEY, []));
let orders = [];
let profile = readSaved(PROFILE_KEY, { name: '', phone: '' });
let sessionToken = localStorage.getItem(SESSION_KEY) || '';
let legacyAccounts = readSaved(ACCOUNTS_KEY, []);
let legacyOrders = readSaved(ORDERS_KEY, []);
if (!sessionToken) {
  profile = { name: '', phone: '' };
  localStorage.removeItem(PROFILE_KEY);
}
const count = document.querySelector('#cart-count');
const orderCount = document.querySelector('#orders-count');
const toast = document.querySelector('.toast');
const footer = document.querySelector('.site-footer');
let toastTimer;
let checkoutAfterLogin = false;
let ordersAfterLogin = false;

const itemList = () => [...cart.entries()].map(([name, item]) => ({ name, price: Number(item.price), quantity: Number(item.quantity) }));
const cartTotal = () => itemList().reduce((sum, item) => sum + item.price * item.quantity, 0);
const money = (amount) => `₹${Number(amount).toLocaleString('en-IN')}`;

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
}

function persistCart() {
  localStorage.setItem(CART_KEY, JSON.stringify([...cart.entries()]));
  count.textContent = itemList().reduce((sum, item) => sum + item.quantity, 0);
}

function persistOrders() {
  syncOrderCount();
}

function ordersForCurrentProfile() {
  const mobile = normalizeMobile(profile.phone || '');
  return mobile ? orders.filter((order) => normalizeMobile(order.customer?.phone || '') === mobile) : [];
}

function syncOrderCount() {
  orderCount.textContent = profile.name?.trim() ? ordersForCurrentProfile().length : 0;
}

function syncProfileName() {
  const label = document.querySelector('#profile-name-label');
  const name = profile.name?.trim();
  label.textContent = name || 'Profile';
  document.querySelector('#profile-button').setAttribute('aria-label', name ? `Open ${name}'s profile` : 'Open your profile');
  document.querySelector('#orders-account-actions').hidden = !name;
  document.querySelector('#orders-account-name').textContent = name || '';
  syncOrderCount();
}

function updateNavigation(active) {
  document.querySelectorAll('.nav-button').forEach((button) => {
    const selected = button.id === `${active}-button`;
    button.classList.toggle('active', selected);
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
}

function openPage(page, scrollPosition = 'top') {
  document.querySelector('#home-page').hidden = page !== 'home';
  document.querySelector('#checkout-page').hidden = page !== 'checkout';
  document.querySelector('#orders-page').hidden = page !== 'orders';
  document.querySelector('#auth-page').hidden = page !== 'auth';
  footer.hidden = page !== 'home';
  updateNavigation(page === 'orders' ? 'orders' : page === 'home' ? 'home' : '');
  if (page === 'checkout') renderCheckout();
  if (page === 'orders') renderOrders();
  window.scrollTo({ top: scrollPosition === 'bottom' ? document.documentElement.scrollHeight : 0, behavior: 'smooth' });
}

function showAuth(view = 'login', returnTo = 'home') {
  checkoutAfterLogin = returnTo === 'checkout';
  ordersAfterLogin = returnTo === 'orders';
  document.querySelectorAll('.auth-form').forEach((form) => { form.hidden = form.id !== `${view}-form`; });
  document.querySelector('#auth-heading').textContent = view === 'signup'
    ? 'Join the Ak’s Dairy family'
    : view === 'forgot' ? 'Forgot your password?' : 'Welcome to Ak’s Dairy';
  document.querySelector('#auth-subheading').textContent = view === 'signup'
    ? 'Create an account for a quicker checkout.'
    : view === 'forgot' ? 'We’ll help you get back into your account.'
      : checkoutAfterLogin ? 'Sign in to continue to your basket.' : 'Sign in with your mobile number to continue.';
  document.querySelector('#auth-message').textContent = '';
  openPage('auth');
}

function normalizeMobile(value) {
  return value.replace(/\D/g, '');
}

async function api(path, data) {
  let response;
  try {
    response = await fetch(path, {
      method: data ? 'POST' : 'GET',
      headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}) },
      body: data ? JSON.stringify(data) : undefined,
    });
  } catch {
    const error = new Error('The SQLite database server is not reachable. Start Ak’s Dairy with “Start Ak’s Dairy.bat”, then open http://localhost:8000.');
    error.databaseOffline = true;
    throw error;
  }
  let result;
  try { result = await response.json(); }
  catch { throw new Error('The database server returned an unreadable response. Restart it with “Start Ak’s Dairy.bat” and try again.'); }
  if (!response.ok) throw new Error(result.error || 'We couldn’t complete that request.');
  return result;
}

function showAuthError(message, error) {
  message.textContent = error.message;
  if (!error.databaseOffline) return;
  const link = document.createElement('a');
  link.href = 'http://localhost:8000';
  link.textContent = 'Open the database connected site';
  link.style.display = 'block';
  link.style.marginTop = '8px';
  message.append(link);
}

async function loadCustomerOrders() {
  if (!profile.name || !profile.phone) { orders = []; persistOrders(); return; }
  const result = await api(`/api/orders?mobile=${encodeURIComponent(normalizeMobile(profile.phone))}`);
  orders = result.orders;
  persistOrders();
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function newPasswordSalt() {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return bytesToHex(salt);
}

async function hashPassword(password, saltHex) {
  if (!crypto.subtle) throw new Error('Secure password storage is not available in this browser.');
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map((byte) => parseInt(byte, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 120000, hash: 'SHA-256' }, key, 256);
  return bytesToHex(bits);
}

function saveSignedInProfile(account) {
  sessionToken = account.token;
  localStorage.setItem(SESSION_KEY, sessionToken);
  profile = { name: account.name, phone: account.phone };
  localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
  syncProfileName();
  const continueCheckout = checkoutAfterLogin;
  const continueOrders = ordersAfterLogin;
  checkoutAfterLogin = false;
  ordersAfterLogin = false;
  loadCustomerOrders().then(() => {
    if (continueCheckout) openCheckout();
    else if (continueOrders) openPage('orders');
    else { openPage('home'); showToast(`Welcome, ${account.name}`); }
  }).catch((error) => { openPage('home'); showToast(error.message); });
}

function renderCheckout() {
  const target = document.querySelector('#checkout-items');
  const rows = itemList();
  target.replaceChildren();
  rows.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'checkout-item';
    row.innerHTML = `<div class="checkout-item-name"><strong>${item.name}</strong><small>${money(item.price)} each</small></div><div class="quantity-controls"><button type="button" data-quantity="-1" data-name="${item.name}" aria-label="Remove one ${item.name}">−</button><span>${item.quantity}</span><button type="button" data-quantity="1" data-name="${item.name}" aria-label="Add one ${item.name}">+</button></div><strong class="checkout-line-total">${money(item.price * item.quantity)}</strong>`;
    target.append(row);
  });
  document.querySelector('#checkout-total').textContent = money(cartTotal());
}

function renderOrders() {
  const target = document.querySelector('#orders-list');
  target.replaceChildren();
  const visibleOrders = orders;
  if (!visibleOrders.length) {
    target.innerHTML = '<div class="empty-orders"><span class="empty-order-icon">✦</span><h2>Your first order is waiting</h2><p>Take a look at our fresh dairy favourites.</p><button class="btn-primary" type="button" data-shop-now>Shop our dairy <span>→</span></button></div>';
    target.querySelector('[data-shop-now]').addEventListener('click', () => {
      openPage('home');
      document.querySelector('#shop').scrollIntoView({ behavior: 'smooth' });
    });
    return;
  }

  [...visibleOrders].reverse().forEach((order) => {
    const card = document.createElement('article');
    card.className = 'order-card';
    const date = new Date(order.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
    const items = order.items.map((item) => `<li>${item.quantity} × ${item.name}<span>${money(item.price * item.quantity)}</span></li>`).join('');
    card.innerHTML = `<div class="order-card-top"><div><small>ORDER ID</small><strong>${order.id}</strong></div><span class="order-status ${order.paymentMethod === 'UPI' ? 'pending' : 'confirmed'}">${order.paymentMethod === 'UPI' ? 'Payment pending' : 'Order placed'}</span></div><div class="order-card-meta"><span>${date}</span><span>${order.paymentMethod}</span></div><ol class="order-tracker" aria-label="Order progress"><li class="is-complete"><i>✓</i><span>Order placed</span></li><li><i>2</i><span>Payment approved</span></li><li><i>3</i><span>Packed</span></li><li><i>4</i><span>Delivered</span></li></ol><ul>${items}</ul><div class="order-card-total"><span>Total</span><strong>${money(order.total)}</strong></div>`;
    target.append(card);
  });
}

function openCheckout() {
  if (cart.size === 0) {
    showToast('Your basket is waiting for something delicious');
    return;
  }
  if (!profile.name?.trim()) {
    showAuth('login', 'checkout');
    return;
  }
  checkoutAfterLogin = false;
  document.querySelector('#checkout-content').hidden = false;
  document.querySelector('#order-success').hidden = true;
  document.querySelector('#customer-name').value = profile.name || '';
  document.querySelector('#customer-phone').value = profile.phone || '';
  document.querySelector('#payment-note').textContent = document.querySelector('input[name="payment"]:checked').value === 'UPI'
    ? 'UPI orders are saved as pending until payment is confirmed.'
    : 'Pay in cash when your order arrives.';
  openPage('checkout');
}

function makeOrderId() {
  const date = new Date();
  const day = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
  let id;
  do {
    const suffix = Math.random().toString(36).slice(2, 9).toUpperCase();
    id = `AKD-${day}-${suffix}`;
  } while (orders.some((order) => order.id === id));
  return id;
}

document.querySelectorAll('.add-button').forEach((button) => {
  button.addEventListener('click', () => {
    const name = button.dataset.product;
    const price = Number(button.dataset.price);
    const item = cart.get(name) || { price, quantity: 0 };
    item.quantity += 1;
    cart.set(name, item);
    persistCart();
    showToast(`${name} added to your basket`);
  });
});

document.querySelectorAll('.buy-now-button').forEach((button) => {
  button.addEventListener('click', () => {
    const name = button.dataset.product;
    const price = Number(button.dataset.price);
    const item = cart.get(name) || { price, quantity: 0 };
    item.quantity += 1;
    cart.set(name, item);
    persistCart();
    openCheckout();
  });
});

const searchInput = document.querySelector('#product-search');
const searchClear = document.querySelector('#clear-search');
const productCards = [...document.querySelectorAll('.product-card')];
function filterProducts() {
  const query = searchInput.value.trim().toLocaleLowerCase();
  let visible = 0;
  productCards.forEach((card) => {
    const matches = card.textContent.toLocaleLowerCase().includes(query);
    card.hidden = !matches;
    if (matches) visible += 1;
  });
  document.querySelector('#search-empty').hidden = visible > 0;
  searchClear.hidden = query.length === 0;
}
searchInput.addEventListener('input', filterProducts);
searchClear.addEventListener('click', () => {
  searchInput.value = '';
  filterProducts();
  searchInput.focus();
});
document.querySelector('#header-search').addEventListener('submit', (event) => {
  event.preventDefault();
  document.querySelector('#shop').scrollIntoView({ behavior: 'smooth' });
});

document.querySelector('#checkout-items').addEventListener('click', (event) => {
  const control = event.target.closest('[data-quantity]');
  if (!control) return;
  const name = control.dataset.name;
  const item = cart.get(name);
  if (!item) return;
  item.quantity += Number(control.dataset.quantity);
  if (item.quantity <= 0) cart.delete(name);
  else cart.set(name, item);
  persistCart();
  renderCheckout();
  if (cart.size === 0) openPage('home');
});

document.querySelector('.cart-button').addEventListener('click', openCheckout);
document.querySelector('#home-button').addEventListener('click', () => openPage('home'));
document.querySelector('#orders-button').addEventListener('click', () => {
  if (profile.name?.trim()) openPage('orders');
  else showAuth('login', 'orders');
});
document.querySelectorAll('[data-go-home]').forEach((button) => button.addEventListener('click', () => openPage('home')));
document.querySelectorAll('[data-go-orders]').forEach((button) => button.addEventListener('click', () => openPage('orders')));

document.querySelector('#profile-button').addEventListener('click', () => {
  if (profile.name?.trim()) {
    syncProfileName();
    openPage('orders', 'bottom');
    return;
  }
  showAuth('login');
});
document.querySelectorAll('[data-auth-view]').forEach((button) => button.addEventListener('click', () => {
  showAuth(button.dataset.authView, checkoutAfterLogin ? 'checkout' : ordersAfterLogin ? 'orders' : 'home');
}));
document.querySelector('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = document.querySelector('#auth-message');
  try {
    const account = await api('/api/login', {
      mobile: normalizeMobile(document.querySelector('#login-mobile').value),
      password: document.querySelector('#login-password').value,
    });
    saveSignedInProfile(account);
  } catch (error) { showAuthError(message, error); }
});
document.querySelector('#signup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const message = document.querySelector('#auth-message');
  const name = document.querySelector('#signup-name').value.trim();
  const mobile = normalizeMobile(document.querySelector('#signup-mobile').value);
  const password = document.querySelector('#signup-password').value;
  const confirmPassword = document.querySelector('#signup-password-confirm').value;
  if (mobile.length < 8 || mobile.length > 15) {
    message.textContent = 'Enter a valid mobile number.';
    return;
  }
  if (password !== confirmPassword) {
    message.textContent = 'Those passwords don’t match yet.';
    return;
  }
  try {
    const account = await api('/api/signup', {
      name, mobile, phone: document.querySelector('#signup-mobile').value.trim(), password,
    });
    saveSignedInProfile(account);
  } catch (error) {
    showAuthError(message, error);
    if (error.message.includes('already exists')) {
      const loginMobile = document.querySelector('#login-mobile');
      loginMobile.value = document.querySelector('#signup-mobile').value;
      message.innerHTML = `${error.message} <button type="button" class="inline-login">Sign in</button>`;
      message.querySelector('.inline-login').addEventListener('click', () => showAuth('login'));
    }
  }
});
document.querySelector('#forgot-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const message = document.querySelector('#auth-message');
  const mobileInput = document.querySelector('#forgot-mobile');
  const resetFields = document.querySelector('#forgot-reset-fields');
  if (resetFields.hidden) {
    try {
      const mobile = normalizeMobile(mobileInput.value);
      await api('/api/recovery-start', { mobile });
      resetFields.hidden = false;
      resetFields.querySelectorAll('input').forEach((input) => { input.required = true; });
      form.querySelector('[type="submit"]').innerHTML = 'Save new password <span>→</span>';
      message.textContent = 'Demo OTP: 123456. Enter it below, then choose a new password.';
    } catch (error) { showAuthError(message, error); }
    return;
  }
  const password = document.querySelector('#reset-password').value;
  const confirm = document.querySelector('#reset-password-confirm').value;
  if (password !== confirm) { message.textContent = 'Those passwords don’t match yet.'; return; }
  try {
    await api('/api/reset-password', {
      mobile: normalizeMobile(mobileInput.value),
      otp: document.querySelector('#reset-otp').value,
      password,
    });
    form.reset();
    resetFields.hidden = true;
    resetFields.querySelectorAll('input').forEach((input) => { input.required = false; });
    form.querySelector('[type="submit"]').innerHTML = 'Send reset code <span>→</span>';
    showAuth('login');
    message.textContent = 'Password updated. Please sign in with your new credentials.';
  } catch (error) { showAuthError(message, error); }
});
document.querySelector('#orders-sign-out').addEventListener('click', async () => {
  try { await api('/api/logout', {}); } catch { /* Clear the local session even if the server is offline. */ }
  sessionToken = '';
  localStorage.removeItem(SESSION_KEY);
  profile = { name: '', phone: '' };
  localStorage.removeItem(PROFILE_KEY);
  cart.clear();
  persistCart();
  checkoutAfterLogin = false;
  ordersAfterLogin = false;
  syncProfileName();
  openPage('home');
  showToast('You’ve signed out');
});

document.querySelectorAll('input[name="payment"]').forEach((input) => input.addEventListener('change', () => {
  document.querySelector('#payment-note').textContent = input.value === 'UPI'
    ? 'UPI orders are saved as pending until payment is confirmed.'
    : 'Pay in cash when your order arrives.';
}));

document.querySelector('#checkout-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!cart.size) return;
  const order = {
    id: makeOrderId(),
    createdAt: new Date().toISOString(),
    customer: {
      name: document.querySelector('#customer-name').value.trim(),
      phone: document.querySelector('#customer-phone').value.trim(),
      address: document.querySelector('#delivery-address').value.trim(),
    },
    paymentMethod: document.querySelector('input[name="payment"]:checked').value,
    items: itemList(),
    total: cartTotal(),
  };
  try {
    await api('/api/orders', { mobile: normalizeMobile(profile.phone), order });
  } catch (error) {
    showToast(error.message);
    return;
  }
  await loadCustomerOrders();
  cart.clear();
  persistCart();
  document.querySelector('#checkout-content').hidden = true;
  document.querySelector('#success-order-id').textContent = order.id;
  document.querySelector('#success-payment').textContent = order.paymentMethod === 'UPI'
    ? 'UPI selected · Payment pending confirmation'
    : 'Cash on delivery selected';
  document.querySelector('#order-success').hidden = false;
  document.querySelector('#checkout-page').classList.remove('celebrating');
  void document.querySelector('#checkout-page').offsetWidth;
  document.querySelector('#checkout-page').classList.add('celebrating');
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

persistCart();
syncProfileName();
api('/api/migrate', { accounts: legacyAccounts, orders: legacyOrders }).then(() => {
  localStorage.removeItem(ACCOUNTS_KEY);
  localStorage.removeItem(ORDERS_KEY);
  legacyAccounts = [];
  legacyOrders = [];
  return loadCustomerOrders();
}).catch((error) => showToast(`Database unavailable: ${error.message}`));

const heroCow = document.querySelector('.hero-cow');
let heroCowAnimationTimer;
heroCow.addEventListener('click', () => {
  heroCow.classList.add('is-standing');
  heroCow.classList.remove('is-animating');
  void heroCow.offsetWidth;
  heroCow.classList.add('is-animating');
  heroCow.setAttribute('aria-pressed', 'true');
  heroCow.setAttribute('aria-label', 'Namaste! The cow is standing and offering fresh milk.');
  heroCow.querySelector('.hero-cow-greeting').textContent = 'Namaste! 🙏';
  clearTimeout(heroCowAnimationTimer);
  heroCowAnimationTimer = setTimeout(() => heroCow.classList.remove('is-animating'), 1250);
});
