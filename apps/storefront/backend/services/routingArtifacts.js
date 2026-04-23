function buildDesiredRoutingArtifact(purchase, provisioningResult) {
    const hostname = String(purchase?.hostname || "").trim();
    const targetCode = String(purchase?.provisioningTargetCode || "").trim();
    const serverIdentifier = String(provisioningResult?.pelicanServerIdentifier || "").trim();
    const allocationId = String(provisioningResult?.pelicanAllocationId || "").trim();

    if (!hostname || !targetCode || !serverIdentifier || !allocationId) {
        throw new Error("Cannot generate desired routing artifact without hostname, target, server identifier, and allocation.");
    }

    return {
        kind: "haproxy_desired_mapping",
        version: 1,
        hostname,
        provisioningTargetCode: targetCode,
        purchaseId: purchase.id,
        pelicanServerIdentifier: serverIdentifier,
        pelicanAllocationId: allocationId,
        generatedAt: Date.now()
    };
}

module.exports = {
    buildDesiredRoutingArtifact
};
