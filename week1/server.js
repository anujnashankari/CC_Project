const express = require("express");
const { exec } = require("child_process");
const bodyParser = require("body-parser");
const path = require("path");

const app = express();
const PORT = 3000;

app.use(bodyParser.json());
app.use(express.static("public")); // Serve frontend files

class NodeManager {
    constructor() {
        this.nodes = {}; 
    }
    
    addNode(nodeId, cpuCores) {
        if (this.nodes[nodeId]) return false;
        this.nodes[nodeId] = { cpuCores, pods: [], status: "Healthy" };
        return true;
    }
    
    removeNode(nodeId) {
        if (!this.nodes[nodeId]) return false;
        delete this.nodes[nodeId];
        return true;
    }
    
    updateNodeStatus(nodeId, status) {
        if (!this.nodes[nodeId]) return false;
        this.nodes[nodeId].status = status;
        return true;
    }
    
    listNodes() {
        return this.nodes;
    }
}

const nodeManager = new NodeManager();

// Serve Homepage
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// API Endpoints
app.post("/addNode", (req, res) => {
    const { nodeId, cpuCores } = req.body;
    if (!nodeId || !cpuCores) {
        return res.status(400).json({ message: "Node ID and CPU cores are required" });
    }
    if (!nodeManager.addNode(nodeId, cpuCores)) {
        return res.status(400).json({ message: "Node ID already exists" });
    }
    res.json({ message: "Node added successfully" });
});

app.delete("/removeNode", (req, res) => {
    const { nodeId } = req.body;
    if (!nodeId) {
        return res.status(400).json({ message: "Node ID is required" });
    }
    if (!nodeManager.removeNode(nodeId)) {
        return res.status(404).json({ message: "Node not found" });
    }
    res.json({ message: "Node removed successfully" });
});

app.put("/updateNodeStatus", (req, res) => {
    const { nodeId, status } = req.body;
    if (!nodeId || !status) {
        return res.status(400).json({ message: "Node ID and status are required" });
    }
    if (!nodeManager.updateNodeStatus(nodeId, status)) {
        return res.status(404).json({ message: "Node not found" });
    }
    res.json({ message: "Node status updated successfully" });
});

app.get("/nodes", (req, res) => {
    res.json(nodeManager.listNodes());
});

app.listen(PORT, () => {
    console.log(`API Server running on port ${PORT}`);
});