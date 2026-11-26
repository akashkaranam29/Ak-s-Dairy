const cart = new Map();
const count = document.querySelector('#cart-count');
const toast = document.querySelector('.toast');
let toastTimer;

document.querySelectorAll('.add-button').forEach((button) => {
  button.addEventListener('click', () => {
    const name = button.dataset.product;
    const price = Number(button.dataset.price);
    const item = cart.get(name) || { price, quantity: 0 };
    item.quantity += 1;
    cart.set(name, item);
    count.textContent = [...cart.values()].reduce((total, product) => total + product.quantity, 0);
    toast.textContent = `${name} added to your basket`;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
  });
});

const menuButton = document.querySelector('.menu-toggle');
const nav = document.querySelector('.main-nav');
menuButton.addEventListener('click', () => {
  const isOpen = nav.classList.toggle('open');
  menuButton.setAttribute('aria-expanded', String(isOpen));
  menuButton.setAttribute('aria-label', isOpen ? 'Close navigation' : 'Open navigation');
});
nav.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => {
  nav.classList.remove('open');
  menuButton.setAttribute('aria-expanded', 'false');
}));

document.querySelector('.cart-button').addEventListener('click', () => {
  const entries = [...cart.entries()];
  toast.textContent = entries.length
    ? `Your basket has ${count.textContent} item${count.textContent === '1' ? '' : 's'} — checkout coming soon`
    : 'Your basket is waiting for something delicious';
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
});

document.querySelectorAll('.cow-mascot').forEach((cow) => {
  let standTimer;
  cow.addEventListener('click', () => {
    cow.classList.remove('giving-milk');
    void cow.offsetWidth;
    cow.classList.add('giving-milk');
    toast.textContent = 'Moo! Fresh milk, just for you 🥛';
    toast.classList.add('show');
    clearTimeout(toastTimer);
    clearTimeout(standTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
    standTimer = setTimeout(() => cow.classList.remove('giving-milk'), 2600);
  });
});
