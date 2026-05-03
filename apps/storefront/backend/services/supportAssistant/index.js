function disabledResult(operation) {
    return {
        enabled: false,
        operation,
        status: "disabled",
        reason: "support_assistant_disabled"
    };
}

async function classifyTicketDraft() {
    return disabledResult("classifyTicketDraft");
}

async function draftReply() {
    return disabledResult("draftReply");
}

async function summarizeDiagnostics() {
    return disabledResult("summarizeDiagnostics");
}

module.exports = {
    classifyTicketDraft,
    draftReply,
    summarizeDiagnostics
};
