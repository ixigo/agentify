const params = new URLSearchParams(location.search);
if (params.get("client") === "green") document.body.classList.add("brand-green");
const app = document.getElementById("app");

function home() {
  app.innerHTML = `
    <section class="hero"><h1>Order food on your train</h1><p>Fresh meals delivered to your seat.</p></section>
    <a class="button" href="/menu${location.search}">See the menu</a>`;
}

async function menu() {
  const response = await fetch(`/api/menu${params.get("fail") ? "?fail=1" : ""}`);
  if (!response.ok) {
    app.innerHTML = `<div class="error" role="alert">The menu could not be loaded. Try again.</div>`;
    return;
  }
  const { items } = await response.json();
  app.innerHTML = `<h1>Menu</h1>${items.map((item) => `
    <div class="card"><span>${item.name} · ₹${item.price}</span><button data-name="${item.name}">Add</button></div>`).join("")}
    <p id="cart" aria-live="polite">Cart is empty</p>`;
  app.querySelectorAll("button").forEach((button) => button.addEventListener("click", async () => {
    const { cartLabel } = await import("/cart.js");
    document.getElementById("cart").textContent = cartLabel(button.dataset.name);
  }));
}

if (location.pathname === "/menu") menu();
else home();
