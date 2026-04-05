let servers = [];

// INIT
async function init() {
    await fetchServers();
    renderServers();
}

// FETCH
async function fetchServers() {
    try {
        const res = await fetch("http://localhost:3000/api/servers");
        servers = await res.json();
    } catch (err) {
        alert("Failed to load servers");
    }
}

// RENDER
function renderServers() {
    const grid = document.getElementById("server-grid");
    grid.innerHTML = "";

    servers.forEach(server => {
        if (server.status !== "available") return;

        const card = document.createElement("div");
        card.className = "server-card";

        card.innerHTML = `
            <h3>${server.type} Server</h3>
            <p>$${server.price}/mo</p>
        `;

        card.onclick = () => selectServer(server);

        grid.appendChild(card);
    });
}

// SELECT
function selectServer(server) {
    const panel = document.getElementById("server-detail");
    panel.classList.remove("hidden");

    panel.innerHTML = `
        <h2>${server.type} Server</h2>
        <p>Optimized configuration. No setup required.</p>

        <input id="server-name" type="text" placeholder="Server Name">
        <input id="email" type="text" placeholder="Email">

        <button id="purchase-btn">
            Purchase - $${server.price}/mo
        </button>

        <p id="status-msg"></p>
    `;

    document.getElementById("purchase-btn").onclick = () => {
        startCheckout(server.id);
    };
}

// CHECKOUT
async function startCheckout(serverId) {
    const name = document.getElementById("server-name").value.trim();
    const email = document.getElementById("email").value.trim();
    const button = document.getElementById("purchase-btn");
    const status = document.getElementById("status-msg");

    if (!name || !email) {
        status.innerText = "Please fill out all fields";
        return;
    }

    button.disabled = true;
    button.innerText = "Processing...";

    try {
        const res = await fetch("http://localhost:3000/api/purchase", {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify({
                serverId,
                name,
                email
            })
        });

        const data = await res.json();

        if (!res.ok) {
            status.innerText = data.error || "Purchase failed";
            button.disabled = false;
            button.innerText = "Try Again";
            return;
        }

        status.innerText = "Purchase successful";

        await fetchServers();
        renderServers();

        setTimeout(() => {
            document.getElementById("server-detail").classList.add("hidden");
        }, 1000);

    } catch (err) {
        status.innerText = "Network error";
        button.disabled = false;
        button.innerText = "Try Again";
    }
}

// START
init();