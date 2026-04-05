// SERVER DATA SOURCE (will become backend later)
function getServerInventory() {
    const data = [];

    // 20x 2GB
    for (let i = 0; i < 20; i++) {
        data.push({
            id: i + 1,
            type: "2GB",
            price: 9.98,
            status: "available"
        });
    }

    // 2x 4GB
    for (let i = 0; i < 2; i++) {
        data.push({
            id: 21 + i,
            type: "4GB",
            price: 31.98,
            status: "available"
        });
    }

    return data;
}

// GLOBAL STATE
let servers = [];

// INIT
function init() {
    servers = getServerInventory();
    renderServers();
}

// RENDER FUNCTION
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

// SELECT SERVER
function selectServer(server) {
    const panel = document.getElementById("server-detail");
    panel.classList.remove("hidden");

    panel.innerHTML = `
        <h2>${server.type} Server</h2>
        <p>Optimized configuration. No setup required.</p>

        <input id="server-name" type="text" placeholder="Server Name">
        <input id="email" type="text" placeholder="Email">

        <button onclick="startCheckout(${server.id})">
            Purchase - $${server.price}/mo
        </button>
    `;
}

// CHECKOUT ENTRY
function startCheckout(serverId) {
    const name = document.getElementById("server-name").value.trim();
    const email = document.getElementById("email").value.trim();

    if (!name || !email) {
        alert("Please fill out all fields");
        return;
    }

    const server = servers.find(s => s.id === serverId);

    const payload = {
        serverId: server.id,
        type: server.type,
        price: server.price,
        name: name,
        email: email
    };

    completePurchase(payload);
}

// FINALIZE (temporary)
function completePurchase(data) {
    const server = servers.find(s => s.id === data.serverId);

    server.status = "sold";

    renderServers();

    document.getElementById("server-detail").classList.add("hidden");
}

// START APP
init();