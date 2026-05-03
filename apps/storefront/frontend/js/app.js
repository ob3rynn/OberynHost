let plans = [];
let resumeCheckout = null;
let checkoutInFlight = null;

async function init() {
    const featuredContainer = document.getElementById("featuredPlans");
    const pricingContainer = document.getElementById("plans");
    const resumeContainer = document.getElementById("resumeCheckout");

    if (!featuredContainer && !pricingContainer) {
        return;
    }

    await Promise.all([
        fetchPlans(),
        pricingContainer ? fetchResumeCheckout() : Promise.resolve()
    ]);

    if (featuredContainer) {
        renderPlans(featuredContainer, {
            ctaLabel: "View Server",
            compact: true
        });
    }

    if (pricingContainer) {
        renderResumeCheckout(resumeContainer);
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
            throw new Error("Could not load servers.");
        }

        plans = await res.json();
    } catch {
        plans = [];
    }
}

async function fetchResumeCheckout() {
    try {
        const res = await fetch("/api/resume-checkout");

        if (!res.ok) {
            throw new Error("Could not check for a resumable checkout.");
        }

        const data = await res.json();
        resumeCheckout = data.resumable ? data : null;
    } catch {
        resumeCheckout = null;
    }
}

function getAvailabilityCopy(plan) {
    if (plan.available === 0) {
        return "Currently full";
    }

    if (plan.available === 1) {
        return "1 server left";
    }

    return `${plan.available} servers available`;
}

function createPlanCard(plan, options = {}) {
    const card = document.createElement("article");
    card.className = `plan-card ${options.compact ? "plan-card--compact" : ""}`;
    const displayName = typeof plan.displayName === "string" && plan.displayName.trim()
        ? plan.displayName.trim()
        : `${plan.type} Paper Server`;

    const header = document.createElement("div");
    header.className = "plan-card__header";
    header.innerHTML = `
        <div>
            <p class="plan-card__eyebrow">${plan.type}</p>
            <h3>${displayName}</h3>
        </div>
        <span class="plan-card__availability ${plan.available === 0 ? "sold-out" : ""}">
            ${getAvailabilityCopy(plan)}
        </span>
    `;
    card.appendChild(header);

    const price = document.createElement("p");
    price.className = "plan-card__price";
    if (plan.priceLabel) {
        price.innerHTML = `<strong>${plan.priceLabel}</strong>`;
    } else {
        price.innerHTML = `<strong>$${plan.price}</strong><span>/ month</span>`;
    }
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
        ? "This server option is full. Join the waitlist and we’ll contact you when a slot opens."
        : "We’ll hold your slot while Stripe opens checkout.";
    footer.appendChild(note);

    const button = document.createElement("button");
    button.className = "button button--primary";
    button.textContent = plan.available === 0 ? "Join Waitlist" : options.ctaLabel || "Get Server";
    button.disabled = false;
    button.dataset.defaultLabel = button.textContent;

    if (plan.available === 0) {
        button.onclick = () => showWaitlistForm(card, plan, button);
    } else {
        button.onclick = () => startCheckout(plan.type, button);
    }

    footer.appendChild(button);
    card.appendChild(footer);

    return card;
}

function showWaitlistForm(card, plan, button) {
    const existing = card.querySelector(".waitlist-form");

    if (existing) {
        existing.querySelector("input")?.focus();
        return;
    }

    const form = document.createElement("form");
    form.className = "waitlist-form";
    form.innerHTML = `
        <label>
            <span>Email</span>
            <input name="email" type="email" autocomplete="email" required>
        </label>
        <label>
            <span>Name</span>
            <input name="name" type="text" autocomplete="name">
        </label>
        <label>
            <span>Note</span>
            <textarea name="note" rows="3"></textarea>
        </label>
        <p class="waitlist-form__message" role="status"></p>
    `;

    const submit = document.createElement("button");
    submit.className = "button button--primary";
    submit.type = "submit";
    submit.textContent = "Join Waitlist";
    form.appendChild(submit);

    form.onsubmit = event => submitWaitlist(event, plan, submit);
    card.appendChild(form);
    button.disabled = true;
}

async function submitWaitlist(event, plan, submitButton) {
    event.preventDefault();
    const form = event.currentTarget;
    const message = form.querySelector(".waitlist-form__message");
    const data = new FormData(form);
    submitButton.disabled = true;
    submitButton.textContent = "Joining...";
    message.textContent = "";

    try {
        const res = await fetch("/api/waitlist", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                planKey: plan.planKey || plan.type,
                email: data.get("email"),
                name: data.get("name"),
                note: data.get("note"),
                source: "storefront"
            })
        });
        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
            message.textContent = payload.error || "Could not join the waitlist right now.";
            return;
        }

        form.reset();
        message.textContent = payload.message || "You're on the waitlist. We'll contact you when a slot opens.";
    } catch {
        message.textContent = "Network error while joining the waitlist.";
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = "Join Waitlist";
    }
}

function renderResumeCheckout(container) {
    if (!container) {
        return;
    }

    container.innerHTML = "";
    container.hidden = !resumeCheckout;

    if (!resumeCheckout) {
        return;
    }

    const copy = document.createElement("div");
    copy.className = "resume-checkout__copy";
    copy.innerHTML = `
        <strong>Resume checkout</strong>
        <p>${resumeCheckout.message}</p>
    `;
    container.appendChild(copy);

    const button = document.createElement("a");
    button.className = "button button--secondary";
    button.href = resumeCheckout.url;
    button.textContent = `Resume ${resumeCheckout.planType} checkout`;
    container.appendChild(button);
}

function showResumeConflict(container, message, resumeUrl, planType) {
    if (!container) {
        return;
    }

    container.innerHTML = "";
    container.hidden = false;

    const copy = document.createElement("div");
    copy.className = "resume-checkout__copy";
    copy.innerHTML = `
        <strong>Checkout already in progress</strong>
        <p>${message}</p>
    `;
    container.appendChild(copy);

    const actions = document.createElement("div");
    actions.className = "resume-checkout__actions";

    const resumeButton = document.createElement("a");
    resumeButton.className = "button button--secondary";
    resumeButton.href = resumeUrl;
    resumeButton.textContent = `Resume ${planType} checkout`;
    actions.appendChild(resumeButton);

    const dismissButton = document.createElement("button");
    dismissButton.type = "button";
    dismissButton.className = "button button--ghost";
    dismissButton.textContent = "Dismiss";
    dismissButton.onclick = () => renderResumeCheckout(container);
    actions.appendChild(dismissButton);

    container.appendChild(actions);
}

function setCheckoutLoadingState(activeButton, active) {
    if (!activeButton || activeButton.dataset.defaultLabel === "Sold Out") {
        return;
    }

    if (active) {
        activeButton.disabled = true;
        activeButton.textContent = "Opening Checkout...";
        return;
    }

    activeButton.disabled = false;
    activeButton.textContent = activeButton.dataset.defaultLabel;
}

function renderPlans(container, options = {}) {
    container.innerHTML = "";

    if (!plans.length) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.textContent = "Server availability is not loading right now. Please refresh and try again.";
        container.appendChild(empty);
        return;
    }

    plans.forEach(plan => {
        container.appendChild(createPlanCard(plan, options));
    });
}

async function startCheckout(planType, button) {
    if (checkoutInFlight) {
        return;
    }

    const resumeContainer = document.getElementById("resumeCheckout");
    checkoutInFlight = planType;
    setCheckoutLoadingState(button, true);

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
            if (res.status === 409 && data.resumeUrl) {
                resumeCheckout = {
                    resumable: true,
                    message: data.error || "You already have a checkout in progress. Resume it instead.",
                    url: data.resumeUrl,
                    planType: data.planType || planType
                };
                showResumeConflict(
                    resumeContainer,
                    resumeCheckout.message,
                    resumeCheckout.url,
                    resumeCheckout.planType
                );
                return;
            }

            if (res.status === 409 && data.redirectUrl) {
                window.location.href = data.redirectUrl;
                return;
            }

            alert(data.error || "Could not start checkout.");
            return;
        }

        window.location.href = data.url;
    } catch {
        alert("Network error while starting checkout.");
    } finally {
        checkoutInFlight = null;
        setCheckoutLoadingState(button, false);
    }
}

init();
