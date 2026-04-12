let plans = [];

async function init() {
    const featuredContainer = document.getElementById("featuredPlans");
    const pricingContainer = document.getElementById("plans");

    if (!featuredContainer && !pricingContainer) {
        return;
    }

    await fetchPlans();

    if (featuredContainer) {
        renderPlans(featuredContainer, {
            ctaLabel: "View Plan",
            compact: true
        });
    }

    if (pricingContainer) {
        renderPlans(pricingContainer, {
            ctaLabel: "Start Checkout",
            compact: false
        });
    }
}

async function fetchPlans() {
    try {
        const res = await fetch("/api/plans");

        if (!res.ok) {
            throw new Error("Could not load plans.");
        }

        plans = await res.json();
    } catch {
        plans = [];
    }
}

function getAvailabilityCopy(plan) {
    if (plan.available === 0) {
        return "Currently sold out";
    }

    if (plan.available === 1) {
        return "1 server left";
    }

    return `${plan.available} servers available`;
}

function createPlanCard(plan, options = {}) {
    const card = document.createElement("article");
    card.className = `plan-card ${options.compact ? "plan-card--compact" : ""}`;

    const header = document.createElement("div");
    header.className = "plan-card__header";
    header.innerHTML = `
        <div>
            <p class="plan-card__eyebrow">${plan.type}</p>
            <h3>${plan.type} Minecraft Server</h3>
        </div>
        <span class="plan-card__availability ${plan.available === 0 ? "sold-out" : ""}">
            ${getAvailabilityCopy(plan)}
        </span>
    `;
    card.appendChild(header);

    const price = document.createElement("p");
    price.className = "plan-card__price";
    price.innerHTML = `<strong>$${plan.price}</strong><span>/ month</span>`;
    card.appendChild(price);

    const list = document.createElement("ul");
    list.className = "feature-list";

    plan.features.forEach(feature => {
        const item = document.createElement("li");
        item.textContent = feature;
        list.appendChild(item);
    });

    card.appendChild(list);

    const footer = document.createElement("div");
    footer.className = "plan-card__footer";

    const note = document.createElement("p");
    note.className = "plan-card__note";
    note.textContent = plan.available === 0
        ? "This plan is unavailable right now."
        : "Checkout will reserve inventory before redirecting to Stripe.";
    footer.appendChild(note);

    const button = document.createElement("button");
    button.className = "button button--primary";
    button.textContent = plan.available === 0 ? "Sold Out" : options.ctaLabel || "Get Server";
    button.disabled = plan.available === 0;

    if (plan.available > 0) {
        button.onclick = () => startCheckout(plan.type);
    }

    footer.appendChild(button);
    card.appendChild(footer);

    return card;
}

function renderPlans(container, options = {}) {
    container.innerHTML = "";

    if (!plans.length) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.textContent = "Plan data is not available right now. Please refresh and try again.";
        container.appendChild(empty);
        return;
    }

    plans.forEach(plan => {
        container.appendChild(createPlanCard(plan, options));
    });
}

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
            alert(data.error || "Could not start checkout.");
            return;
        }

        window.location.href = data.url;
    } catch {
        alert("Network error while starting checkout.");
    }
}

init();
