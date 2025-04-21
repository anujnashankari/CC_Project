const express = require("express")
const { exec } = require("child_process")
const cors = require("cors")
const app = express()
const PORT = process.env.PORT || 3000

// Middleware
app.use(cors())
app.use(express.json())
app.use(express.static("public"))

// In-memory data structures
const nodes = new Map() // Map of node ID to node details
const pods = new Map() // Map of pod ID to pod details

// Scheduling algorithms
const SCHEDULING_ALGORITHMS = {
  FIRST_FIT: "first-fit",
  BEST_FIT: "best-fit",
  WORST_FIT: "worst-fit",
}

// Default scheduling algorithm
let currentSchedulingAlgorithm = SCHEDULING_ALGORITHMS.FIRST_FIT

// Node Manager
class NodeManager {
  static addNode(nodeId, cpuCores, containerId = null) {
    if (nodes.has(nodeId)) {
      return { success: false, message: `Node ${nodeId} already exists` }
    }

    if (!containerId) {
      containerId = `container-${Date.now()}-${Math.floor(Math.random() * 10000)}`
    }

    const newNode = {
      id: nodeId,
      containerId: containerId,
      cpuCores: cpuCores,
      availableCpuCores: cpuCores,
      pods: [],
      lastHeartbeat: Date.now(),
      status: "healthy",
    }

    nodes.set(nodeId, newNode)
    return { success: true, node: newNode }
  }

  static getNodes() {
    return Array.from(nodes.values())
  }

  static getNode(nodeId) {
    return nodes.get(nodeId)
  }

  static updateNode(nodeId, updates) {
    const node = nodes.get(nodeId)
    if (!node) {
      return { success: false, message: `Node ${nodeId} not found` }
    }

    // Only allow updating certain fields
    if (updates.cpuCores !== undefined) {
      // If reducing CPU cores, check if it's still enough for existing pods
      const totalPodCpu = node.pods.reduce((total, podId) => {
        const pod = pods.get(podId)
        return total + (pod ? pod.cpuRequirement : 0)
      }, 0)

      if (updates.cpuCores < totalPodCpu) {
        return {
          success: false,
          message: `Cannot reduce CPU cores to ${updates.cpuCores}. Current pods require ${totalPodCpu} cores.`,
        }
      }

      node.availableCpuCores = updates.cpuCores - (node.cpuCores - node.availableCpuCores)
      node.cpuCores = updates.cpuCores
    }

    return { success: true, node }
  }

  static updateNodeStatus(nodeId, status) {
    const node = nodes.get(nodeId)
    if (node) {
      node.status = status
      node.lastHeartbeat = Date.now()
      return true
    }
    return false
  }

  static removeNode(nodeId) {
    const node = nodes.get(nodeId)
    if (!node) {
      return { success: false, message: `Node ${nodeId} not found` }
    }

    // Check if node has pods
    if (node.pods.length > 0) {
      return {
        success: false,
        message: `Cannot remove node ${nodeId}. It still has ${node.pods.length} pods. Reschedule or delete pods first.`,
      }
    }

    nodes.delete(nodeId)
    return { success: true, message: `Node ${nodeId} removed successfully` }
  }
}

// Pod Scheduler
class PodScheduler {
  static schedulePod(cpuRequirement) {
    const podId = `pod-${Date.now()}-${Math.floor(Math.random() * 1000)}`

    // Find a suitable node based on the current scheduling algorithm
    const nodeId = this._findSuitableNode(cpuRequirement)

    if (!nodeId) {
      return { success: false, message: "No suitable node found for pod scheduling" }
    }

    // Update node resources
    const node = nodes.get(nodeId)
    node.availableCpuCores -= cpuRequirement
    node.pods.push(podId)

    // Create pod record
    const pod = {
      id: podId,
      cpuRequirement,
      nodeId,
      status: "running",
      createdAt: Date.now(),
    }

    pods.set(podId, pod)

    return { success: true, pod, node }
  }

  static _findSuitableNode(cpuRequirement) {
    const healthyNodes = Array.from(nodes.values()).filter(
      (node) => node.status === "healthy" && node.availableCpuCores >= cpuRequirement,
    )

    if (healthyNodes.length === 0) {
      return null
    }

    switch (currentSchedulingAlgorithm) {
      case SCHEDULING_ALGORITHMS.BEST_FIT:
        // Find node with the least available CPU that can still fit the pod
        healthyNodes.sort((a, b) => a.availableCpuCores - b.availableCpuCores)
        return healthyNodes[0].id

      case SCHEDULING_ALGORITHMS.WORST_FIT:
        // Find node with the most available CPU
        healthyNodes.sort((a, b) => b.availableCpuCores - a.availableCpuCores)
        return healthyNodes[0].id

      case SCHEDULING_ALGORITHMS.FIRST_FIT:
      default:
        // Return the first node that can fit the pod
        return healthyNodes[0].id
    }
  }

  static getPods() {
    return Array.from(pods.values())
  }

  static getPod(podId) {
    return pods.get(podId)
  }

  static updatePod(podId, updates) {
    const pod = pods.get(podId)
    if (!pod) {
      return { success: false, message: `Pod ${podId} not found` }
    }

    // Only allow updating certain fields
    if (updates.cpuRequirement !== undefined) {
      const node = nodes.get(pod.nodeId)
      if (!node) {
        return { success: false, message: `Node ${pod.nodeId} not found` }
      }

      // Check if the node has enough resources for the updated requirement
      const additionalCpu = updates.cpuRequirement - pod.cpuRequirement
      if (node.availableCpuCores < additionalCpu) {
        return {
          success: false,
          message: `Node ${pod.nodeId} does not have enough resources for the updated CPU requirement`,
        }
      }

      // Update node resources
      node.availableCpuCores -= additionalCpu
      pod.cpuRequirement = updates.cpuRequirement
    }

    return { success: true, pod }
  }

  static removePod(podId) {
    const pod = pods.get(podId)
    if (!pod) {
      return { success: false, message: `Pod ${podId} not found` }
    }

    // Update node resources
    const node = nodes.get(pod.nodeId)
    if (node) {
      node.availableCpuCores += pod.cpuRequirement
      node.pods = node.pods.filter((id) => id !== podId)
    }

    pods.delete(podId)
    return { success: true, message: `Pod ${podId} removed successfully` }
  }

  static reschedulePod(podId) {
    const pod = pods.get(podId)
    if (!pod) {
      return { success: false, message: `Pod ${podId} not found` }
    }

    // Remove pod from current node
    const currentNode = nodes.get(pod.nodeId)
    if (currentNode) {
      currentNode.pods = currentNode.pods.filter((id) => id !== podId)
      currentNode.availableCpuCores += pod.cpuRequirement
    }

    // Find a new node
    const newNodeId = this._findSuitableNode(pod.cpuRequirement)
    if (!newNodeId) {
      pod.status = "pending"
      return { success: false, message: "No suitable node found for pod rescheduling" }
    }

    // Update pod and new node
    const newNode = nodes.get(newNodeId)
    newNode.pods.push(podId)
    newNode.availableCpuCores -= pod.cpuRequirement
    pod.nodeId = newNodeId
    pod.status = "running"

    return { success: true, pod }
  }

  static setSchedulingAlgorithm(algorithm) {
    if (Object.values(SCHEDULING_ALGORITHMS).includes(algorithm)) {
      currentSchedulingAlgorithm = algorithm
      return { success: true, algorithm }
    }
    return { success: false, message: "Invalid scheduling algorithm" }
  }

  static getSchedulingAlgorithm() {
    return currentSchedulingAlgorithm
  }
}

// Health Monitor
class HealthMonitor {
  static checkNodeHealth() {
    const now = Date.now()
    const HEARTBEAT_TIMEOUT = 10000 // 10 seconds

    for (const [nodeId, node] of nodes.entries()) {
      if (now - node.lastHeartbeat > HEARTBEAT_TIMEOUT) {
        node.status = "unhealthy"

        // Reschedule pods from unhealthy node
        this.handleNodeFailure(nodeId)
      }
    }
  }

  static handleNodeFailure(nodeId) {
    const node = nodes.get(nodeId)
    if (!node) return

    console.log(`Node ${nodeId} has failed. Rescheduling pods...`)

    // Get all pods on the failed node
    const nodePods = node.pods.slice()

    // Reschedule each pod
    for (const podId of nodePods) {
      const result = PodScheduler.reschedulePod(podId)
      console.log(`Rescheduling pod ${podId}: ${result.success ? "Success" : "Failed"}`)
    }
  }

  static recordHeartbeat(nodeId) {
    const node = nodes.get(nodeId)
    if (node) {
      node.lastHeartbeat = Date.now()
      node.status = "healthy"
      return true
    }
    return false
  }
}

// Docker operations
class DockerManager {
  // Check if a container with the given name exists
  static checkContainerExists(containerName, callback) {
    exec(`docker ps -a --filter "name=^/${containerName}$" --format "{{.Names}}"`, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error checking container: ${error.message}`)
        callback(error, false)
        return
      }
      
      // If stdout contains the container name, it exists
      callback(null, stdout.trim() === containerName)
    })
  }
  
  // Generate a unique container name to avoid conflicts
  static generateUniqueContainerName(baseName) {
    return `${baseName}-${Date.now()}`
  }
  
  // Remove a container if it exists
  static removeContainer(containerName, callback) {
    exec(`docker rm -f ${containerName}`, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error removing container: ${error.message}`)
        callback(error)
        return
      }
      
      callback(null, stdout.trim())
    })
  }
}

// Start health check interval
setInterval(() => {
  HealthMonitor.checkNodeHealth()
}, 5000)

// API Routes

// Node operations
app.post("/api/nodes", (req, res) => {
  const { nodeId, cpuCores } = req.body

  if (!nodeId || !cpuCores) {
    return res.status(400).json({ success: false, message: "Node ID and CPU cores are required" })
  }

  if (isNaN(cpuCores) || cpuCores <= 0) {
    return res.status(400).json({ success: false, message: "CPU requirement must be a positive number" })
  }

  // Generate a unique container name to avoid conflicts
  const containerName = DockerManager.generateUniqueContainerName(nodeId)
  
  console.log(`Attempting to launch container with name ${containerName} for node ${nodeId} with ${cpuCores} CPU cores`)
  
  // Try to launch a Docker container with the unique name
  exec(`docker run -d --name ${containerName} --label type=cluster-node alpine sh -c "while true; do sleep 5; done"`, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error launching Docker container: ${error.message}`)
      console.log("Falling back to simulation mode...")
      
      // If Docker fails, fall back to simulation mode
      const result = NodeManager.addNode(nodeId, parseInt(cpuCores))
      return res.json(result)
    }
    
    // Docker container launched successfully
    const containerId = stdout.trim()
    console.log(`Container launched with ID: ${containerId}`)
    const result = NodeManager.addNode(nodeId, parseInt(cpuCores), containerId)
    return res.json(result)
  })
})

app.get("/api/nodes", (req, res) => {
  const nodesList = NodeManager.getNodes()
  res.json({ success: true, nodes: nodesList })
})

app.get("/api/nodes/:nodeId", (req, res) => {
  const { nodeId } = req.params
  const node = NodeManager.getNode(nodeId)

  if (node) {
    res.json({ success: true, node })
  } else {
    res.status(404).json({ success: false, message: `Node ${nodeId} not found` })
  }
})

app.put("/api/nodes/:nodeId", (req, res) => {
  const { nodeId } = req.params
  const updates = req.body

  const result = NodeManager.updateNode(nodeId, updates)

  if (result.success) {
    res.json(result)
  } else {
    res.status(400).json(result)
  }
})

app.delete("/api/nodes/:nodeId", (req, res) => {
  const { nodeId } = req.params
  const node = NodeManager.getNode(nodeId)
  
  if (!node) {
    return res.status(404).json({ success: false, message: `Node ${nodeId} not found` })
  }
  
  // If this is a real Docker container, try to remove it first
  if (node.containerId && node.containerId.startsWith('container-') === false) {
    exec(`docker rm -f ${node.containerId}`, (error, stdout, stderr) => {
      if (error) {
        console.error(`Error removing container: ${error.message}`)
        // Continue with node removal even if container removal fails
      } else {
        console.log(`Container ${node.containerId} removed successfully`)
      }
      
      const result = NodeManager.removeNode(nodeId)
      if (result.success) {
        res.json(result)
      } else {
        res.status(400).json(result)
      }
    })
  } else {
    // For simulated nodes, just remove from our records
    const result = NodeManager.removeNode(nodeId)
    if (result.success) {
      res.json(result)
    } else {
      res.status(400).json(result)
    }
  }
})

app.post("/api/nodes/:nodeId/heartbeat", (req, res) => {
  const { nodeId } = req.params
  const success = HealthMonitor.recordHeartbeat(nodeId)

  if (success) {
    res.json({ success: true, message: `Heartbeat recorded for node ${nodeId}` })
  } else {
    res.status(404).json({ success: false, message: `Node ${nodeId} not found` })
  }
})

// Pod operations
app.post("/api/pods", (req, res) => {
  const { cpuRequirement } = req.body

  if (!cpuRequirement) {
    return res.status(400).json({ success: false, message: "CPU requirement is required" })
  }

  if (isNaN(cpuRequirement) || cpuRequirement <= 0) {
    return res.status(400).json({ success: false, message: "CPU requirement must be a positive number" })
  }

  const result = PodScheduler.schedulePod(Number.parseInt(cpuRequirement))
  res.json(result)
})

app.get("/api/pods", (req, res) => {
  try {
    const podsList = PodScheduler.getPods()
    res.json({ success: true, pods: podsList })
  } catch (error) {
    console.error("Error fetching pods:", error)
    res.status(500).json({ success: false, message: "Failed to fetch pods" })
  }
})

app.get("/api/pods/:podId", (req, res) => {
  const { podId } = req.params
  const pod = PodScheduler.getPod(podId)

  if (pod) {
    res.json({ success: true, pod })
  } else {
    res.status(404).json({ success: false, message: `Pod ${podId} not found` })
  }
})

app.put("/api/pods/:podId", (req, res) => {
  const { podId } = req.params
  const updates = req.body

  const result = PodScheduler.updatePod(podId, updates)

  if (result.success) {
    res.json(result)
  } else {
    res.status(400).json(result)
  }
})

app.delete("/api/pods/:podId", (req, res) => {
  const { podId } = req.params
  const result = PodScheduler.removePod(podId)

  if (result.success) {
    res.json(result)
  } else {
    res.status(400).json(result)
  }
})

// Scheduling algorithm
app.post("/api/scheduler/algorithm", (req, res) => {
  const { algorithm } = req.body
  const result = PodScheduler.setSchedulingAlgorithm(algorithm)
  res.json(result)
})

app.get("/api/scheduler/algorithm", (req, res) => {
  const algorithm = PodScheduler.getSchedulingAlgorithm()
  res.json({ success: true, algorithm })
})

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Server error:", err)
  res.status(500).json({ success: false, message: "Internal server error" })
})

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`)
})