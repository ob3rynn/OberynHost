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

        const featuresHTML = plan.features
            .map(f => `<li>✔ ${f}</li>`)
            .join("");

        card.innerHTML = `
            <h2>${plan.type} Server</h2>
            <p><strong>$${plan.price}/month</strong></p>

            <ul>
                ${featuresHTML}
            </ul>

            <p>${plan.available} available</p>

            <button ${plan.available === 0 ? "disabled" : ""}>
                ${plan.available === 0 ? "Sold Out" : "Get Server"}
            </button>
        `;

        const button = card.querySelector("button");

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