const express = require("express")
const { exec } = require("child_process")
const bodyParser = require("body-parser")
const path = require("path")

const app = express()
const PORT = 3000

app.use(bodyParser.json())
app.use(express.static("public")) // Serve frontend files

// Scheduling algorithms
const SCHEDULING_ALGORITHMS = {
  FIRST_FIT: "first-fit",
  BEST_FIT: "best-fit",
  WORST_FIT: "worst-fit",
}

class NodeManager {
  constructor() {
    this.nodes = {}
    this.pods = {}
    this.heartbeatIntervals = {}
    this.schedulingAlgorithm = SCHEDULING_ALGORITHMS.FIRST_FIT // Default algorithm
    this.startHealthMonitor()
  }

  async addNode(nodeId, cpuCores) {
    if (this.nodes[nodeId]) return { success: false, message: "Node already exists" }

    try {
      // Launch a new container to simulate the physical node
      const containerId = await execPromise(`docker run -dit alpine sleep 3600`)
      this.nodes[nodeId] = {
        cpuCores,
        availableCpu: cpuCores,
        pods: [],
        status: "Healthy",
        containerId,
        lastHeartbeat: Date.now(),
      }
      this.heartbeatIntervals[nodeId] = Date.now()
      console.log(`Node ${nodeId} added with ${cpuCores} CPU cores. Container ID: ${containerId}`)
      return { success: true, message: "Node added successfully", containerId }
    } catch (error) {
      console.error(`Error adding node: ${error}`)
      return { success: false, message: "Docker error: " + error }
    }
  }

  removeNode(nodeId) {
    const node = this.nodes[nodeId]
    if (!node) return { success: false, message: "Node not found" }

    try {
      // Remove the container
      exec(`docker rm -f ${node.containerId}`)

      // Reschedule pods if any
      this.reschedulePods(nodeId)

      delete this.nodes[nodeId]
      delete this.heartbeatIntervals[nodeId]
      console.log(`Node ${nodeId} removed successfully`)
      return { success: true, message: "Node removed successfully" }
    } catch (error) {
      console.error(`Error removing node: ${error}`)
      return { success: false, message: "Error removing node: " + error }
    }
  }

  updateNodeStatus(nodeId, status) {
    if (!this.nodes[nodeId]) return { success: false, message: "Node not found" }
    this.nodes[nodeId].status = status
    console.log(`Node ${nodeId} status updated to ${status}`)

    // If node is marked unhealthy, reschedule its pods
    if (status === "Unhealthy") {
      this.reschedulePods(nodeId)
    }

    return { success: true, message: "Node status updated" }
  }

  sendHeartbeat(nodeId) {
    if (!this.nodes[nodeId]) return { success: false, message: "Node not found" }
    this.nodes[nodeId].status = "Healthy"
    this.nodes[nodeId].lastHeartbeat = Date.now()
    this.heartbeatIntervals[nodeId] = Date.now()
    console.log(`Heartbeat received from node ${nodeId}`)
    return { success: true, message: "Heartbeat received" }
  }

  setSchedulingAlgorithm(algorithm) {
    if (!Object.values(SCHEDULING_ALGORITHMS).includes(algorithm)) {
      return { success: false, message: "Invalid scheduling algorithm" }
    }
    this.schedulingAlgorithm = algorithm
    console.log(`Scheduling algorithm set to ${algorithm}`)
    return { success: true, message: `Scheduling algorithm set to ${algorithm}` }
  }

  findNodeForPod(cpuRequest) {
    const healthyNodes = Object.entries(this.nodes).filter(
      ([_, node]) => node.status === "Healthy" && node.availableCpu >= cpuRequest,
    )

    if (healthyNodes.length === 0) {
      return null
    }

    let selectedNode

    switch (this.schedulingAlgorithm) {
      case SCHEDULING_ALGORITHMS.BEST_FIT:
        // Best-Fit: Node with the least available CPU that can still fit the pod
        selectedNode = healthyNodes.reduce((best, current) => {
          return current[1].availableCpu < best[1].availableCpu ? current : best
        })
        break

      case SCHEDULING_ALGORITHMS.WORST_FIT:
        // Worst-Fit: Node with the most available CPU
        selectedNode = healthyNodes.reduce((worst, current) => {
          return current[1].availableCpu > worst[1].availableCpu ? current : worst
        })
        break

      case SCHEDULING_ALGORITHMS.FIRST_FIT:
      default:
        // First-Fit: First node that can accommodate the pod
        selectedNode = healthyNodes[0]
        break
    }

    return selectedNode
  }

  async schedulePod(podId, cpuRequest = 1, isRescheduled = false) {
    if (this.pods[podId] && !isRescheduled) {
      return { success: false, message: "Pod ID already exists" }
    }

    const selectedNode = this.findNodeForPod(cpuRequest)

    if (!selectedNode) {
      return { success: false, message: "No available nodes with sufficient CPU" }
    }

    const [nodeId, node] = selectedNode

    try {
      // Launch a container to simulate the pod
      const containerId = await execPromise(`docker run -dit alpine sleep 3600`)
      node.pods.push(podId)
      node.availableCpu -= cpuRequest

      this.pods[podId] = {
        podId,
        nodeId,
        cpuRequest,
        containerId,
        status: "Running",
      }

      console.log(`Pod ${podId} scheduled on node ${nodeId} using ${cpuRequest} CPU cores`)
      return {
        success: true,
        message: "Pod launched",
        nodeId,
        containerId,
        algorithm: this.schedulingAlgorithm,
      }
    } catch (err) {
      console.error(`Error scheduling pod: ${err}`)
      return { success: false, message: "Failed to launch pod: " + err }
    }
  }

  deletePod(podId) {
    const pod = this.pods[podId]
    if (!pod) return { success: false, message: "Pod not found" }

    const node = this.nodes[pod.nodeId]
    if (node) {
      node.pods = node.pods.filter((p) => p !== podId)
      node.availableCpu += pod.cpuRequest
    }

    // Remove the container
    exec(`docker rm -f ${pod.containerId}`)
    delete this.pods[podId]

    console.log(`Pod ${podId} deleted successfully`)
    return { success: true, message: "Pod deleted", containerId: pod.containerId }
  }

  startHealthMonitor() {
    console.log("Health monitor started. Checking node health every 10 seconds.")
    setInterval(() => this.checkNodeHealth(), 10000) // every 10 seconds
  }

  async checkNodeHealth() {
    const now = Date.now()
    for (const nodeId of Object.keys(this.nodes)) {
      // If no heartbeat received in the last 60 seconds, mark as unhealthy
      if (now - this.heartbeatIntervals[nodeId] > 60000) {
        if (this.nodes[nodeId].status !== "Unhealthy") {
          console.log(`Node ${nodeId} marked as Unhealthy due to missed heartbeats.`)
          this.nodes[nodeId].status = "Unhealthy"
          await this.reschedulePods(nodeId)
        }
      }
    }
  }

  async reschedulePods(unhealthyNodeId) {
    const node = this.nodes[unhealthyNodeId]
    if (!node) return

    const podsToReschedule = [...node.pods]
    console.log(`Attempting to reschedule ${podsToReschedule.length} pods from unhealthy node ${unhealthyNodeId}`)

    for (const podId of podsToReschedule) {
      const oldPod = this.pods[podId]
      if (!oldPod) continue

      const cpuRequest = oldPod.cpuRequest
      const oldContainerId = oldPod.containerId

      // Remove from old node tracking
      node.pods = node.pods.filter((p) => p !== podId)
      node.availableCpu += cpuRequest

      // Mark pod as rescheduling
      oldPod.status = "Rescheduling"

      const result = await this.schedulePod(podId, cpuRequest, true)

      if (result.success) {
        // Remove old container
        exec(`docker rm -f ${oldContainerId}`)
        console.log(`✅ Pod ${podId} rescheduled from ${unhealthyNodeId} to ${result.nodeId}`)

        // Update pod status
        this.pods[podId].status = "Running"
      } else {
        console.log(`❌ Failed to reschedule pod ${podId}: ${result.message}`)
        // rollback
        this.pods[podId] = {
          ...oldPod,
          status: "Failed",
        }
        node.pods.push(podId)
        node.availableCpu -= cpuRequest
      }
    }
  }

  getClusterStats() {
    const totalNodes = Object.keys(this.nodes).length
    const healthyNodes = Object.values(this.nodes).filter((node) => node.status === "Healthy").length
    const totalPods = Object.keys(this.pods).length
    const totalCPU = Object.values(this.nodes).reduce((sum, node) => sum + node.cpuCores, 0)
    const usedCPU = Object.values(this.nodes).reduce((sum, node) => sum + (node.cpuCores - node.availableCpu), 0)

    return {
      totalNodes,
      healthyNodes,
      totalPods,
      totalCPU,
      usedCPU,
      cpuUtilization: totalCPU > 0 ? ((usedCPU / totalCPU) * 100).toFixed(2) : 0,
    }
  }

  listNodes() {
    return this.nodes
  }

  listPods() {
    return this.pods
  }
}

function execPromise(command) {
  return new Promise((resolve, reject) => {
    exec(command, (err, stdout, stderr) => {
      if (err) reject(stderr)
      else resolve(stdout.trim())
    })
  })
}

const nodeManager = new NodeManager()

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"))
})

app.post("/addNode", async (req, res) => {
  const { nodeId, cpuCores } = req.body
  if (!nodeId || !cpuCores) return res.status(400).json({ message: "Node ID and CPU cores are required" })
  const result = await nodeManager.addNode(nodeId, cpuCores)
  res.status(result.success ? 200 : 400).json(result)
})

app.delete("/removeNode", (req, res) => {
  const { nodeId } = req.body
  if (!nodeId) return res.status(400).json({ message: "Node ID is required" })
  const result = nodeManager.removeNode(nodeId)
  res.status(result.success ? 200 : 404).json(result)
})

app.put("/updateNodeStatus", (req, res) => {
  const { nodeId, status } = req.body
  if (!nodeId || !status) return res.status(400).json({ message: "Node ID and status are required" })
  const result = nodeManager.updateNodeStatus(nodeId, status)
  res.status(result.success ? 200 : 404).json(result)
})

app.post("/heartbeat", (req, res) => {
  const { nodeId } = req.body
  if (!nodeId) return res.status(400).json({ message: "Node ID is required" })
  const result = nodeManager.sendHeartbeat(nodeId)
  res.status(result.success ? 200 : 404).json(result)
})

app.post("/launchPod", async (req, res) => {
  const { podId, cpuRequest = 1 } = req.body
  if (!podId) return res.status(400).json({ message: "Pod ID is required" })
  const result = await nodeManager.schedulePod(podId, cpuRequest)
  res.status(result.success ? 200 : 400).json(result)
})

app.delete("/deletePod", (req, res) => {
  const { podId } = req.body
  if (!podId) return res.status(400).json({ message: "Pod ID is required" })
  const result = nodeManager.deletePod(podId)
  res.status(result.success ? 200 : 404).json(result)
})

app.put("/setSchedulingAlgorithm", (req, res) => {
  const { algorithm } = req.body
  if (!algorithm) return res.status(400).json({ message: "Algorithm is required" })
  const result = nodeManager.setSchedulingAlgorithm(algorithm)
  res.status(result.success ? 200 : 400).json(result)
})

app.get("/nodes", (req, res) => {
  res.json(nodeManager.listNodes())
})

app.get("/pods", (req, res) => {
  res.json(nodeManager.listPods())
})

app.get("/clusterStats", (req, res) => {
  res.json(nodeManager.getClusterStats())
})

app.listen(PORT, () => {
  console.log(`API Server running on port ${PORT}`)
})
