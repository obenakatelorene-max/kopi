import express, { Request, Response } from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import { db, OrderStatus } from './server/db.js';

const app = express();
const PORT = 3000;

app.use(express.json());

// Create HTTP server to bind both Express and WebSockets on port 3000
const httpServer = http.createServer(app);

// WebSocket Setup
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

interface ClientMeta {
  role: 'admin' | 'customer';
  orderId?: string | number;
}

const clients = new Map<WebSocket, ClientMeta>();

wss.on('connection', (ws: WebSocket, req) => {
  clients.set(ws, { role: 'customer' });

  ws.on('message', (message: string) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.type === 'init') {
        const meta = clients.get(ws) || { role: 'customer' };
        if (data.role) meta.role = data.role;
        if (data.orderId) meta.orderId = data.orderId;
        clients.set(ws, meta);
        ws.send(JSON.stringify({ type: 'connected', role: meta.role, timestamp: Date.now() }));
      }
    } catch (e) {
      // Ignore invalid JSON
    }
  });

  ws.on('close', () => {
    clients.delete(ws);
  });

  // Welcome message
  ws.send(JSON.stringify({ type: 'connected', message: 'Connected to KKEOPI Real-Time Stream' }));
});

// Broadcast helper functions
export function broadcastToAll(type: string, payload: any) {
  const message = JSON.stringify({ type, payload, timestamp: Date.now() });
  for (const [client, _] of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

export function broadcastToAdmins(type: string, payload: any) {
  const message = JSON.stringify({ type, payload, timestamp: Date.now() });
  for (const [client, meta] of clients) {
    if (client.readyState === WebSocket.OPEN && meta.role === 'admin') {
      client.send(message);
    }
  }
}

export function broadcastOrderStatus(order: any) {
  const message = JSON.stringify({
    type: 'order:status_updated',
    payload: {
      order_id: order.id,
      status: order.status,
      order,
    },
    timestamp: Date.now(),
  });

  for (const [client, meta] of clients) {
    if (client.readyState === WebSocket.OPEN) {
      // Admins receive all updates, or customers tracking this specific order
      if (meta.role === 'admin' || String(meta.orderId) === String(order.id)) {
        client.send(message);
      }
    }
  }
}

// ==========================================
// LARAVEL-COMPLIANT REST API ENDPOINTS
// ==========================================

// 1. PRODUCTS API

// GET /api/products - Get all products with optional category filter
app.get('/api/products', async (req: Request, res: Response) => {
  try {
    const category = req.query.category as string | undefined;
    const products = await db.getProducts(category);
    res.json({ success: true, data: products });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Failed to fetch products' });
  }
});

// GET /api/products/:id - Get single product
app.get('/api/products/:id', async (req: Request, res: Response) => {
  try {
    const product = await db.getProductById(req.params.id);
    if (!product) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }
    res.json({ success: true, data: product });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/products - Create product (Admin with Laravel-style Validation)
app.post('/api/products', async (req: Request, res: Response) => {
  try {
    const { name, description, price, category, image, is_available } = req.body;

    // Validation rules
    const errors: Record<string, string> = {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      errors.name = 'The name field is required.';
    }
    if (price === undefined || isNaN(Number(price)) || Number(price) <= 0) {
      errors.price = 'The price field must be a valid number greater than 0.';
    }
    if (!category || !['Coffee', 'Non-Coffee', 'Pastries'].includes(category)) {
      errors.category = 'The category must be Coffee, Non-Coffee, or Pastries.';
    }

    if (Object.keys(errors).length > 0) {
      return res.status(422).json({
        success: false,
        message: 'The given data was invalid.',
        errors,
      });
    }

    const product = await db.createProduct({
      name: name.trim(),
      description: (description || '').trim(),
      price: Number(price),
      category,
      image: image || 'https://images.unsplash.com/photo-1517701604599-bb29b565090c?auto=format&fit=crop&w=800&q=80',
      is_available: is_available !== undefined ? Boolean(is_available) : true,
    });

    broadcastToAll('product:created', product);

    res.status(201).json({
      success: true,
      message: 'Product created successfully',
      data: product,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/products/:id - Update product
app.put('/api/products/:id', async (req: Request, res: Response) => {
  try {
    const { name, description, price, category, image, is_available } = req.body;
    const existing = await db.getProductById(req.params.id);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }

    const updates: any = {};
    if (name !== undefined) updates.name = String(name).trim();
    if (description !== undefined) updates.description = String(description).trim();
    if (price !== undefined) {
      if (isNaN(Number(price)) || Number(price) <= 0) {
        return res.status(422).json({
          success: false,
          errors: { price: 'Price must be a positive number' },
        });
      }
      updates.price = Number(price);
    }
    if (category !== undefined) updates.category = category;
    if (image !== undefined) updates.image = image;
    if (is_available !== undefined) updates.is_available = Boolean(is_available);

    const updated = await db.updateProduct(req.params.id, updates);
    broadcastToAll('product:updated', updated);

    res.json({
      success: true,
      message: 'Product updated successfully',
      data: updated,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/products/:id - Delete product
app.delete('/api/products/:id', async (req: Request, res: Response) => {
  try {
    const success = await db.deleteProduct(req.params.id);
    if (!success) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }
    broadcastToAll('product:deleted', { id: req.params.id });
    res.json({ success: true, message: 'Product deleted successfully' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. ORDERS API

// GET /api/orders - Get all orders (supports optional ?user_id= or ?status=, and Bearer token)
app.get('/api/orders', async (req: Request, res: Response) => {
  try {
    let userId = req.query.user_id as string | undefined;

    // If no explicit user_id query param, check if Authorization token is sent
    // Only restrict to userId if the user is a CUSTOMER; ADMIN sees all orders
    if (!userId && req.headers.authorization?.startsWith('Bearer ')) {
      const token = req.headers.authorization.substring(7).trim();
      const verified = await db.verifySupabaseToken(token);
      if (verified && verified.role !== 'ADMIN') {
        userId = verified.id;
      }
    }

    const orders = await db.getOrders(userId);
    res.json({ success: true, data: orders });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/orders/my-orders - Retrieve authenticated customer's own orders
app.get('/api/orders/my-orders', async (req: Request, res: Response) => {
  try {
    let userId: string | null = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7).trim();
      const verified = await db.verifySupabaseToken(token);
      if (verified) userId = verified.id;
    }

    if (!userId && req.query.user_id) {
      userId = String(req.query.user_id);
    }

    if (!userId) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required. Please sign in with Supabase Google Auth.',
      });
    }

    const orders = await db.getOrders(userId);
    res.json({ success: true, data: orders });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/orders/:id - Get specific order
app.get('/api/orders/:id', async (req: Request, res: Response) => {
  try {
    const order = await db.getOrderById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }
    res.json({ success: true, data: order });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/orders - Customer places an order (Laravel-style validation & Supabase Auth identity)
app.post('/api/orders', async (req: Request, res: Response) => {
  try {
    const { customer_name, customer_email, items, notes, user_id } = req.body;

    // Validate Supabase authenticated user from Authorization header
    let authenticatedUserId: string | null = null;
    let verifiedUser = null;
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7).trim();
      verifiedUser = await db.verifySupabaseToken(token);
      if (verifiedUser) {
        authenticatedUserId = verifiedUser.id;
      }
    }

    // Determine stable Supabase user ID
    const finalUserId = authenticatedUserId || (user_id ? String(user_id).trim() : null);

    // Validation
    const errors: Record<string, string> = {};
    const finalName = verifiedUser?.name || (customer_name && String(customer_name).trim()) || '';
    const finalEmail = verifiedUser?.email || (customer_email && String(customer_email).trim()) || '';

    if (!finalName) {
      errors.customer_name = 'Customer name is required.';
    }
    if (!finalEmail || !finalEmail.includes('@')) {
      errors.customer_email = 'A valid email address is required.';
    }
    if (!Array.isArray(items) || items.length === 0) {
      errors.items = 'At least one order item is required.';
    } else {
      items.forEach((it, idx) => {
        if (!it.product_id) {
          errors[`items.${idx}.product_id`] = 'Product ID is required.';
        }
        if (!it.quantity || isNaN(Number(it.quantity)) || Number(it.quantity) < 1) {
          errors[`items.${idx}.quantity`] = 'Quantity must be an integer of at least 1.';
        }
      });
    }

    if (Object.keys(errors).length > 0) {
      return res.status(422).json({
        success: false,
        message: 'Order validation failed.',
        errors,
      });
    }

    // Create order in DB (Supabase PostgreSQL / local store)
    const order = await db.createOrder({
      customer_name: finalName,
      customer_email: finalEmail,
      notes: notes ? String(notes).trim() : '',
      user_id: finalUserId,
      items: items.map((it) => ({
        product_id: it.product_id,
        quantity: Math.floor(Number(it.quantity)),
      })),
    });

    // Real-Time Event: Notify Admin Dashboard via WebSocket
    broadcastToAll('order:created', {
      order,
      notification: `New order #${order.id} from ${order.customer_name} (₱${order.total_amount})`,
    });

    res.status(201).json({
      success: true,
      message: 'Order created successfully',
      data: order,
    });
  } catch (err: any) {
    res.status(400).json({ success: false, error: err.message || 'Failed to place order' });
  }
});

// PUT /api/orders/:id/status - Admin updates order status
app.put('/api/orders/:id/status', async (req: Request, res: Response) => {
  try {
    const { status } = req.body;
    const validStatuses: OrderStatus[] = [
      'PENDING',
      'CONFIRMED',
      'PREPARING',
      'READY',
      'COMPLETED',
      'CANCELLED',
    ];

    if (!status || !validStatuses.includes(status)) {
      return res.status(422).json({
        success: false,
        message: 'Invalid status supplied.',
        allowed: validStatuses,
      });
    }

    const order = await db.updateOrderStatus(req.params.id, status);
    if (!order) {
      return res.status(404).json({ success: false, error: 'Order not found' });
    }

    // Real-Time Event: Broadcast status change to customer tracking and admin
    broadcastOrderStatus(order);

    res.json({
      success: true,
      message: `Order #${order.id} status updated to ${status}`,
      data: order,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. AUTHENTICATION & SUPABASE USERS API

// GET /api/auth/config - Public Supabase configuration for client-side Auth
app.get('/api/auth/config', (req: Request, res: Response) => {
  const rawUrl = process.env.SUPABASE_URL || '';
  const cleanUrl = rawUrl.replace(/\/rest\/v1\/?$/i, '').replace(/\/rest\/?$/i, '').replace(/\/+$/, '');
  const anonKey = (process.env.SUPABASE_ANON_KEY || '').trim();

  res.json({
    success: true,
    data: {
      supabaseUrl: cleanUrl,
      supabaseAnonKey: anonKey,
    },
  });
});

// POST /api/auth/sync - Synchronize Supabase authenticated user session with Laravel/PostgreSQL
app.post('/api/auth/sync', async (req: Request, res: Response) => {
  try {
    let token = '';
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    }

    let user = null;
    if (token) {
      user = await db.verifySupabaseToken(token);
    }

    // If body contains user payload (e.g. from client session), sync directly
    if (!user && req.body && req.body.id && req.body.email) {
      user = await db.syncSupabaseUser({
        id: req.body.id,
        email: req.body.email,
        name: req.body.name,
        profile_image: req.body.avatar || req.body.profile_image,
        role: req.body.role || (req.body.email.toLowerCase().includes('admin') ? 'ADMIN' : 'CUSTOMER'),
      });
    }

    if (!user) {
      return res.status(422).json({
        success: false,
        error: 'Unable to synchronize user. Valid Supabase session or user profile required.',
      });
    }

    res.json({
      success: true,
      message: 'Supabase user session synchronized successfully',
      data: user,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/auth/me - Check current Supabase authenticated session
app.get('/api/auth/me', async (req: Request, res: Response) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.substring(7).trim();
      const user = await db.verifySupabaseToken(token);
      if (user) {
        return res.json({
          success: true,
          data: {
            authenticated: true,
            user,
          },
        });
      }
    }

    res.json({
      success: true,
      data: {
        authenticated: false,
        guest: true,
      },
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. STATS & SUPABASE HEALTH
app.get('/api/stats', async (req: Request, res: Response) => {
  try {
    const stats = await db.getStats();
    res.json({ success: true, data: stats });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/supabase/status', (req: Request, res: Response) => {
  const status = db.getSupabaseStatus();
  res.json({ success: true, data: status });
});

app.post('/api/supabase/reconnect', async (req: Request, res: Response) => {
  await db.initSupabase();
  const status = db.getSupabaseStatus();
  res.json({ success: true, data: status });
});

// ==========================================
// VITE MIDDLEWARE & STATIC ASSETS SERVING
// ==========================================
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`KKEOPI Full-Stack Ordering Server running on http://0.0.0.0:${PORT}`);
    console.log(`WebSockets stream active on ws://0.0.0.0:${PORT}/ws`);
  });
}

startServer();
