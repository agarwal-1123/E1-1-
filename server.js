const express = require("express");
const fs = require('fs');
const path = require('path');
const { initializeDatabase, saveOrder, getAllOrders } = require('./database');
const app = express();

const PORT = process.env.PORT || 3000;

// Initialize database
initializeDatabase();

app.use(express.static('.'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// API to get orders
app.get('/api/orders', (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    
    fs.readFile('orders-new.csv', 'utf8', (err, data) => {
        if (err) {
            return res.status(500).json({ error: 'Failed to read orders' });
        }
        
        const lines = data.split('\n');
        const orderMap = new Map();
        
        for (let i = 1; i < lines.length; i++) {
            if (!lines[i].trim()) continue;
            
            const values = lines[i].split(',');
            const orderData = {
                orderID: values[0],
                itemID: values[1],
                itemName: values[2],
                category: values[3],
                packTime: parseInt(values[4]),
                weight: parseFloat(values[5]),
                dimensions: values[6],
                vas: values[7] === 'true',
                fragile: values[8] === 'true',
                priority: values[9],
                quantity: parseInt(values[10]) || 1
            };
            
            if (!orderMap.has(orderData.orderID)) {
                orderMap.set(orderData.orderID, {
                    id: orderData.orderID,
                    items: 0,
                    itemDetails: [],
                    priority: orderData.priority,
                    totalPackTime: 0,
                    hasVAS: false,
                    hasFragile: false
                });
            }
            
            const order = orderMap.get(orderData.orderID);
            order.items++;
            orderData.quantity = orderData.quantity || 1;
            order.itemDetails.push(orderData);
            
            let itemPackTime = orderData.packTime * orderData.quantity;
            if (orderData.vas) {
                itemPackTime += 2 * orderData.quantity;
                order.hasVAS = true;
            }
            if (orderData.fragile) {
                itemPackTime += 1 * orderData.quantity;
                order.hasFragile = true;
            }
            
            order.totalPackTime += itemPackTime;
            order.items += orderData.quantity - 1;
        }
        
        const orders = Array.from(orderMap.values()).map(order => {
            let timeMultiplier = 1;
            if (order.priority === 'High') timeMultiplier = 0.8;
            else if (order.priority === 'Low') timeMultiplier = 1.2;
            
            return {
                ...order,
                estimatedTime: Math.round(order.totalPackTime * timeMultiplier),
                station: null,
                status: 'Pending'
            };
        });
        
        res.json(orders);
    });
});

// API to balance load
app.post('/api/balance', (req, res) => {
    const { orders, stationCount } = req.body;
    
    let stations = [];
    for (let i = 1; i <= stationCount; i++) {
        stations.push({
            id: i,
            name: `Station ${i}`,
            orders: [],
            totalTime: 0,
            status: 'Idle',
            loadBalance: 0
        });
    }
    
    // Simple load balancing - assign to least loaded station
    const sortedOrders = [...orders].sort((a, b) => {
        const priorityWeight = { 'High': 3, 'Medium': 2, 'Low': 1 };
        if (priorityWeight[a.priority] !== priorityWeight[b.priority]) {
            return priorityWeight[b.priority] - priorityWeight[a.priority];
        }
        return b.estimatedTime - a.estimatedTime;
    });
    
    sortedOrders.forEach(order => {
        const bestStation = stations.sort((a, b) => a.totalTime - b.totalTime)[0];
        
        order.station = bestStation.id;
        order.status = 'Assigned';
        bestStation.orders.push(order);
        bestStation.totalTime += order.estimatedTime;
        bestStation.status = 'Active';
    });
    
    const totalTime = stations.reduce((sum, s) => sum + s.totalTime, 0);
    const avgTime = totalTime / stations.length;
    
    stations.forEach(station => {
        if (station.totalTime === 0) {
            station.loadBalance = 0;
            station.efficiency = 0;
            station.status = 'Idle';
        } else {
            station.loadBalance = Math.round(100 - Math.abs(station.totalTime - avgTime) / avgTime * 100);
            station.efficiency = Math.round((station.totalTime / (Math.max(...stations.map(s => s.totalTime)) || 1)) * 100);
            const timeRatio = station.totalTime / avgTime;
            if (timeRatio > 1.2) {
                station.status = 'Overloaded';
            } else if (timeRatio > 0.8) {
                station.status = 'Optimal';
            } else {
                station.status = 'Light Load';
            }
        }
    });
    
    res.json({ orders: sortedOrders, stations });
});

// API to save customer orders
app.post('/api/orders', async (req, res) => {
    try {
        const order = req.body;
        const orderId = await saveOrder(order);
        res.json({ success: true, orderId: orderId });
    } catch (error) {
        console.error('Error saving order:', error);
        res.status(500).json({ error: 'Failed to save order' });
    }
});

// API to get all customer orders
app.get('/api/customer-orders', async (req, res) => {
    try {
        const orders = await getAllOrders();
        res.json(orders);
    } catch (error) {
        console.error('Error loading orders:', error);
        res.status(500).json({ error: 'Failed to load orders' });
    }
});

// API to get all orders (database orders)
app.get('/api/all-orders', async (req, res) => {
    try {
        const orders = await getAllOrders();
        res.json(orders);;
    } catch (error) {
        console.error('Error loading orders:', error);
        res.status(500).json({ error: 'Failed to load orders' });
    }
});

// API to update order assignments
app.post('/api/update-orders', (req, res) => {
    const updatedOrders = req.body;
    
    try {
        // Read existing orders
        const data = fs.readFileSync('customer-orders.json', 'utf8');
        const allOrders = JSON.parse(data);
        
        // Update orders with new station assignments
        updatedOrders.forEach(updatedOrder => {
            const orderIndex = allOrders.findIndex(o => o.id === updatedOrder.id);
            if (orderIndex !== -1) {
                allOrders[orderIndex].station = updatedOrder.station;
                allOrders[orderIndex].status = updatedOrder.status;
            }
        });
        
        // Save updated orders back to file
        fs.writeFileSync('customer-orders.json', JSON.stringify(allOrders, null, 2));
        
        res.json({ success: true });
    } catch (error) {
        console.error('Error updating orders:', error);
        res.status(500).json({ error: 'Failed to update orders' });
    }
});

app.get("/", (req, res) => {
  res.send("Hello from Render!");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});