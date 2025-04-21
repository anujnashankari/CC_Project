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

// Docker operations
class DockerManager {
  // Check if a container with the given name exists
  static checkContainerExists(containerName) {
    return new Promise((resolve, reject) => {
      exec(`docker ps -a --filter "name=^/${containerName}$" --format "{{.Names}}"`, (error, stdout, stderr) => {
        if (error) {
          console.error(`Error checking container: ${error.message}`)
          reject(error)
          return
        }
        
        // If stdout contains the container name, it exists
        resolve(stdout.trim() === containerName)
      })
    })
  }
  
  // Generate a unique container name to avoid conflicts
  static generateUniqueContainerName(baseName) {
    return `${baseName}-${Date.now()}`
  }
  
  // Remove a container if it exists
  static removeContainer(containerName) {
    return new Promise((resolve, reject) => {
      exec(`docker rm -f ${containerName}`, (error, stdout, stderr) => {
        if (error) {
          console.error(`Error removing container: ${error.message}`)
          reject(error)
          return
        }
        
        resolve(stdout.trim())
      })
    })
  }
  
  // Launch a container for a pod - returns the container ID
  static launchPodContainer(containerName, nodeId) {
    return new Promise((resolve, reject) => {
      // Get the associated node's container ID to establish linking
      const node = nodes.get(nodeId)
      if (!node) {
        reject(new Error(`Node ${nodeId} not found`))
        return
      }
      
      exec(`docker run -d --name ${containerName} --label node=${nodeId} --label type=pod alpine sh -c "while true; do sleep 60; done"`, (error, stdout, stderr) => {
        if (error) {
          reject(error)
          return
        }
        
        resolve(stdout.trim()) // Return the container ID
      })
    })
  }
  
  // Launch a container for a node - returns the container ID
  static launchNodeContainer(containerName) {
    return new Promise((resolve, reject) => {
      exec(`docker run -d --name ${containerName} --label type=cluster-node alpine sh -c "while true; do sleep 60; done"`, (error, stdout, stderr) => {
        if (error) {
          reject(error)
          return
        }
        
        resolve(stdout.trim()) // Return the container ID
      })
    })
  }
  
  // Get container information including ID
  static getContainerInfo(containerName) {
    return new Promise((resolve, reject) => {
      exec(`docker inspect --format="{{.Id}}" ${containerName}`, (error, stdout, stderr) => {
        if (error) {
          reject(error)
          return
        }
        
        resolve(stdout.trim()) // Return the container ID
      })
    })
  }
}

// Node Manager
class NodeManager {
  static async addNode(nodeId, cpuCores, containerId = null) {
    if (nodes.has(nodeId)) {
      return { success: false, message: `Node ${nodeId} already exists` }
    }

    const newNode = {
      id: nodeId,
      containerId: containerId || `container-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
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
  static async schedulePod(cpuRequirement) {
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

    // Generate a unique container name for the pod
    const containerName = DockerManager.generateUniqueContainerName(`pod-${podId}`)
    
    try {
      // Launch a Docker container for the pod
      const containerId = await DockerManager.launchPodContainer(containerName, nodeId)
      
      // Create pod record
      const pod = {
        id: podId,
        cpuRequirement,
        nodeId,
        containerId: containerId, 
        status: "running",
        createdAt: Date.now(),
      }

      pods.set(podId, pod)
      return { success: true, pod, node }
    } catch (error) {
      console.error(`Error launching pod container: ${error.message}`)
      
      // Free up the resources since pod creation failed
      node.availableCpuCores += cpuRequirement
      node.pods = node.pods.filter(id => id !== podId)
      
      return { success: false, message: `Failed to create pod container: ${error.message}` }
    }
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

  static async removePod(podId) {
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

    // Remove the Docker container
    try {
      await DockerManager.removeContainer(pod.containerId)
      console.log(`Container for pod ${podId} removed successfully`)
    } catch (error) {
      console.error(`Error removing container for pod ${podId}: ${error.message}`)
      // We'll still remove the pod from our system even if container removal fails
    }

    pods.delete(podId)
    return { success: true, message: `Pod ${podId} removed successfully` }
  }

  static async reschedulePod(podId) {
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
    
    try {
      // Remove the old container
      try {
        await DockerManager.removeContainer(pod.containerId)
      } catch (error) {
        console.error(`Error removing old container for pod ${podId}: ${error.message}`)
        // Continue with pod rescheduling even if container removal fails
      }
      
      // Create a new container for the pod on the new node
      const containerName = DockerManager.generateUniqueContainerName(`pod-${podId}`)
      const containerId = await DockerManager.launchPodContainer(containerName, newNodeId)
      
      // Update the pod's container ID
      pod.containerId = containerId
      pod.status = "running"
      
      return { success: true, pod }
    } catch (error) {
      // Revert the node resource changes if container creation fails
      newNode.pods = newNode.pods.filter(id => id !== podId)
      newNode.availableCpuCores += pod.cpuRequirement
      
      if (currentNode) {
        currentNode.pods.push(podId)
        currentNode.availableCpuCores -= pod.cpuRequirement
        pod.nodeId = currentNode.id
      } else {
        pod.status = "error"
      }
      
      return { success: false, message: `Failed to reschedule pod: ${error.message}` }
    }
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

  static async handleNodeFailure(nodeId) {
    const node = nodes.get(nodeId)
    if (!node) return

    console.log(`Node ${nodeId} has failed. Rescheduling pods...`)

    // Get all pods on the failed node
    const nodePods = node.pods.slice()

    // Reschedule each pod
    for (const podId of nodePods) {
      const result = await PodScheduler.reschedulePod(podId)
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

// Start health check interval
setInterval(() => {
  HealthMonitor.checkNodeHealth()
}, 5000)

// API Routes

// Node operations
app.post("/api/nodes", async (req, res) => {
  const { nodeId, cpuCores } = req.body

  if (!nodeId || !cpuCores) {
    return res.status(400).json({ success: false, message: "Node ID and CPU cores are required" })
  }

  if (isNaN(cpuCores) || cpuCores <= 0) {
    return res.status(400).json({ success: false, message: "CPU requirement must be a positive number" })
  }

  // Generate a unique container name to avoid conflicts
  const containerName = DockerManager.generateUniqueContainerName(nodeId)
  
  try {
    // Launch a Docker container for the node
    const containerId = await DockerManager.launchNodeContainer(containerName)
    
    // Add the node to our system
    const result = await NodeManager.addNode(nodeId, parseInt(cpuCores), containerId)
    res.json(result)
  } catch (error) {
    console.error(`Error creating node: ${error.message}`)
    res.status(500).json({ success: false, message: `Failed to create node: ${error.message}` })
  }
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

app.delete("/api/nodes/:nodeId", async (req, res) => {
  const { nodeId } = req.params
  const node = NodeManager.getNode(nodeId)
  
  if (!node) {
    return res.status(404).json({ success: false, message: `Node ${nodeId} not found` })
  }
  
  // Check if node has pods
  const result = NodeManager.removeNode(nodeId)
  if (!result.success) {
    return res.status(400).json(result)
  }
  
  // Remove the Docker container
  try {
    await DockerManager.removeContainer(node.containerId)
    console.log(`Container for node ${nodeId} removed successfully`)
  } catch (error) {
    console.error(`Error removing container for node ${nodeId}: ${error.message}`)
    // We'll still consider the node removal successful even if container removal fails
  }
  
  res.json(result)
})

app.post("/api/nodes/:nodeId/heartbeat", (req, res) => {
  const { nodeId } = req.params
  // Fix: Use the nodeId directly from the URL parameter
  const success = HealthMonitor.recordHeartbeat(nodeId)

  if (success) {
    res.json({ success: true, message: `Heartbeat recorded for node ${nodeId}` })
  } else {
    res.status(404).json({ success: false, message: `Node ${nodeId} not found` })
  }
})

// Pod operations
app.post("/api/pods", async (req, res) => {
  const { cpuRequirement } = req.body

  if (!cpuRequirement) {
    return res.status(400).json({ success: false, message: "CPU requirement is required" })
  }

  if (isNaN(cpuRequirement) || cpuRequirement <= 0) {
    return res.status(400).json({ success: false, message: "CPU requirement must be a positive number" })
  }

  try {
    const result = await PodScheduler.schedulePod(Number.parseInt(cpuRequirement))
    res.json(result)
  } catch (error) {
    console.error("Error scheduling pod:", error)
    res.status(500).json({ success: false, message: `Failed to schedule pod: ${error.message}` })
  }
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

app.delete("/api/pods/:podId", async (req, res) => {
  const { podId } = req.params
  
  try {
    const result = await PodScheduler.removePod(podId)
    if (result.success) {
      res.json(result)
    } else {
      res.status(400).json(result)
    }
  } catch (error) {
    console.error("Error removing pod:", error)
    res.status(500).json({ success: false, message: `Failed to remove pod: ${error.message}` })
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
  console.log("Make sure Docker is running to create real containers")
})