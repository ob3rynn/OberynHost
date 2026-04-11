let plans = [];

// INIT
async function init() {
    await fetchPlans();
    renderPlans();
}

// FETCH
async function fetchPlans() {
    const res = await fetch("/api/plans");
    plans = await res.json();
}

// RENDER
function renderPlans() {
    const container = document.getElementById("plans");
    container.innerHTML = "";

    plans.forEach(plan => {
        const card = document.createElement("div");
        card.className = "card";
        const title = document.createElement("h2");
        title.textContent = `${plan.type} Server`;
        card.appendChild(title);

        const price = document.createElement("p");
        const strong = document.createElement("strong");
        strong.textContent = `$${plan.price}/month`;
        price.appendChild(strong);
        card.appendChild(price);

        const list = document.createElement("ul");

        plan.features.forEach(feature => {
            const item = document.createElement("li");
            item.textContent = `✔ ${feature}`;
            list.appendChild(item);
        });

        card.appendChild(list);

        const availability = document.createElement("p");
        availability.textContent = `${plan.available} available`;
        card.appendChild(availability);

        const button = document.createElement("button");
        button.textContent = plan.available === 0 ? "Sold Out" : "Get Server";
        button.disabled = plan.available === 0;
        card.appendChild(button);

        if (plan.available > 0) {
            button.onclick = () => startCheckout(plan.type);
        }

        container.appendChild(card);
    });
}

// CHECKOUT
async function startCheckout(planType) {
    try {
        const res = await fetch("/api/create-checkout", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ planType })
        });

        const data = await res.json();

        if (!res.ok) {
            alert(data.error);
            return;
        }

        window.location.href = data.url;

    } catch {
        alert("Network error");
    }
}

// START
init();
