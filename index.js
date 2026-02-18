const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cloudinary = require('cloudinary').v2;
const { MercadoPagoConfig, Preference } = require('mercadopago');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'goldplan-secret-key-2026';

// Cloudinary configuration
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'daxkzdokg',
    api_key: process.env.CLOUDINARY_API_KEY || '333635244693392',
    api_secret: process.env.CLOUDINARY_API_SECRET || '4lT-cx9Uy4sA0x9Vo-Eic1dYzGM'
});

// Mercado Pago configuration
const mpClient = new MercadoPagoConfig({
    accessToken: process.env.MP_ACCESS_TOKEN || 'APP_USR-8218840125474261-021812-815143d60dbf6685b0272c2cd0c941d6-2908654793'
});
const mpPreference = new Preference(mpClient);

// Función para subir imagen a Cloudinary
async function uploadToCloudinary(base64Image) {
    if (!base64Image) return null;
    
    // Si ya es una URL de Cloudinary, retornarla
    if (base64Image.startsWith('http')) return base64Image;
    
    // Si no es base64, retornar null
    if (!base64Image.startsWith('data:image')) return null;
    
    try {
        const result = await cloudinary.uploader.upload(base64Image, {
            folder: 'goldplan',
            transformation: [
                { width: 1200, height: 800, crop: 'limit' },
                { quality: 'auto:good' },
                { fetch_format: 'auto' }
            ]
        });
        return result.secure_url;
    } catch (err) {
        console.error('Error subiendo a Cloudinary:', err.message);
        return null;
    }
}

// Función para subir múltiples imágenes
async function uploadMultipleToCloudinary(images) {
    if (!images || !Array.isArray(images) || images.length === 0) return [];
    
    const uploadedUrls = [];
    for (const img of images) {
        const url = await uploadToCloudinary(img);
        if (url) uploadedUrls.push(url);
    }
    return uploadedUrls;
}

// Database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Middleware
app.use(cors());

// JSON parser con mejor manejo de errores
app.use(express.json({ 
    limit: '50mb',
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

// Manejar errores de parsing JSON
app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Archivo demasiado grande. Máximo 50MB.' });
    }
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        return res.status(400).json({ error: 'JSON inválido' });
    }
    if (err.type === 'request.aborted') {
        console.log('Request abortada por el cliente');
        return; // No enviar respuesta, el cliente ya se desconectó
    }
    next(err);
});

// Auth middleware
const authMiddleware = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token requerido' });
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        res.status(401).json({ error: 'Token inválido' });
    }
};

const superadminMiddleware = (req, res, next) => {
    if (req.user.role !== 'superadmin') {
        return res.status(403).json({ error: 'Acceso denegado' });
    }
    next();
};

// Initialize database tables
async function initDB() {
    const client = await pool.connect();
    try {
        // Users table
        await client.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(100) UNIQUE NOT NULL,
                name VARCHAR(200) NOT NULL,
                password VARCHAR(255) NOT NULL,
                role VARCHAR(50) DEFAULT 'admin',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Vehicles 0km table - con campo images para array de imágenes
        await client.query(`
            CREATE TABLE IF NOT EXISTS vehicles_0km (
                id SERIAL PRIMARY KEY,
                brand VARCHAR(100) NOT NULL,
                name VARCHAR(200) NOT NULL,
                price VARCHAR(50),
                plan VARCHAR(100),
                anticipo VARCHAR(50),
                cuota VARCHAR(50),
                description TEXT,
                image TEXT,
                images TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Agregar columna images si no existe (para bases de datos existentes)
        await client.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='vehicles_0km' AND column_name='images') THEN
                    ALTER TABLE vehicles_0km ADD COLUMN images TEXT;
                END IF;
            END $$;
        `);

        // Vehicles usados table - con campo images para array de imágenes
        await client.query(`
            CREATE TABLE IF NOT EXISTS vehicles_usados (
                id SERIAL PRIMARY KEY,
                brand VARCHAR(100) NOT NULL,
                modelo VARCHAR(200) NOT NULL,
                year INTEGER,
                km VARCHAR(50),
                price VARCHAR(50),
                description TEXT,
                image TEXT,
                images TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Agregar columna images si no existe (para bases de datos existentes)
        await client.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='vehicles_usados' AND column_name='images') THEN
                    ALTER TABLE vehicles_usados ADD COLUMN images TEXT;
                END IF;
            END $$;
        `);

        // Config table
        await client.query(`
            CREATE TABLE IF NOT EXISTS config (
                id SERIAL PRIMARY KEY,
                key VARCHAR(100) UNIQUE NOT NULL,
                value TEXT
            )
        `);

        // Check if superadmin exists, if not create it
        const superadmin = await client.query("SELECT * FROM users WHERE username = 'Luca.Caorsi'");
        if (superadmin.rows.length === 0) {
            const hashedPassword = await bcrypt.hash('Luca270202', 10);
            await client.query(
                "INSERT INTO users (username, name, password, role) VALUES ($1, $2, $3, $4)",
                ['Luca.Caorsi', 'Luca Caorsi', hashedPassword, 'superadmin']
            );
            console.log('Superadmin created');
        }

        // Check if 0km vehicles exist, if not insert defaults
        const vehicles = await client.query("SELECT COUNT(*) FROM vehicles_0km");
        if (parseInt(vehicles.rows[0].count) === 0) {
            await insertDefaultVehicles(client);
            console.log('Default vehicles inserted');
        }

        console.log('Database initialized successfully');
    } catch (err) {
        console.error('Error initializing database:', err);
    } finally {
        client.release();
    }
}

async function insertDefaultVehicles(client) {
    const vehicles = [
        { brand: 'volkswagen', name: 'Tera Trend MSI MT MY26', price: '$36.391.350', plan: '70/30 • 84 Cuotas', anticipo: '$10.917.405', cuota: '$347.103', description: 'El nuevo Volkswagen Tera Trend representa la evolución del SUV compacto urbano. Equipado con motorización MSI de alta eficiencia que combina potencia y bajo consumo de combustible. Su diseño exterior moderno incluye faros LED, parrilla cromada y llantas de aleación de 17 pulgadas. El interior ofrece climatizador automático, sistema de infoentretenimiento con pantalla táctil de 8 pulgadas compatible con Android Auto y Apple CarPlay, y sensores de estacionamiento traseros. Incluye 6 airbags, control de estabilidad y asistente de arranque en pendiente para máxima seguridad.' },
        { brand: 'volkswagen', name: 'T-Cross Trendline 200 TSI AT MY26', price: '$52.851.350', plan: '70/30 • 84 Cuotas', anticipo: '$15.855.405', cuota: '$504.100', description: 'El Volkswagen T-Cross Trendline 200 TSI AT es el SUV urbano líder del segmento.' },
        { brand: 'volkswagen', name: 'Nivus Trendline 200 TSI AT MY26', price: '$45.775.000', plan: '70/30 • 84 Cuotas', anticipo: '$13.732.500', cuota: '$436.605', description: 'El Volkswagen Nivus es un innovador SUV Coupé que combina diseño deportivo con funcionalidad.' },
        { brand: 'volkswagen', name: 'Amarok Trendline TDI MT 4x2 MY25', price: '$58.255.550', plan: '60/40 • 84 Cuotas', anticipo: '$23.302.220', cuota: '$508.493', description: 'La Volkswagen Amarok Trendline TDI es la pick-up de alta gama.' },
        { brand: 'volkswagen', name: 'Taos Comfortline 250 TSI AT', price: '$56.942.500', plan: '60/40 • 84 Cuotas', anticipo: '$22.777.000', cuota: '$497.032', description: 'El Volkswagen Taos Comfortline es el SUV mediano premium.' },
        { brand: 'fiat', name: 'Titano Endurance MT 4x4', price: '$52.890.000', plan: '70/30 • 84 Cuotas', anticipo: '$15.867.000', cuota: '$533.219', description: 'La nueva Fiat Titano Endurance MT 4x4.' },
        { brand: 'fiat', name: 'Argo Drive 1.3 MT', price: '$29.780.000', plan: '70/30 • 84 Cuotas', anticipo: '$8.934.000', cuota: '$300.232', description: 'El Fiat Argo Drive 1.3 MT.' },
        { brand: 'fiat', name: 'Cronos Drive 1.3 MT5 Pack Plus', price: '$37.020.000', plan: '80/20 • 84 Cuotas', anticipo: '$7.404.000', cuota: '$422.627', description: 'El Fiat Cronos Drive 1.3.' },
        { brand: 'fiat', name: 'Fastback Turbo 270 AT6', price: '$45.310.000', plan: '60/40 • 84 Cuotas', anticipo: '$18.124.000', cuota: '$396.333', description: 'El Fiat Fastback Turbo 270 AT6.' },
        { brand: 'fiat', name: 'Mobi Trekking 1.0', price: '$27.070.000', plan: '80/20 • 84 Cuotas', anticipo: '$5.414.000', cuota: '$309.036', description: 'El Fiat Mobi Trekking 1.0.' },
        { brand: 'fiat', name: 'Toro Freedom T270 AT6 4x2', price: '$47.250.000', plan: '70/30 • 84 Cuotas', anticipo: '$14.175.000', cuota: '$476.359', description: 'La Fiat Toro Freedom T270 AT6 4x2.' },
        { brand: 'fiat', name: 'Pulse Drive 1.3L MT', price: '$36.670.000', plan: '70/30 • 84 Cuotas', anticipo: '$11.001.000', cuota: '$369.695', description: 'El Fiat Pulse Drive 1.3L MT.' },
        { brand: 'fiat', name: 'Fiorino Endurance 1.4L', price: '$29.310.000', plan: '70/30 • 84 Cuotas', anticipo: '$8.793.000', cuota: '$295.494', description: 'El Fiat Fiorino Endurance 1.4L.' },
        { brand: 'fiat', name: 'Strada Freedom CD', price: '$37.520.000', plan: '70/30 • 84 Cuotas', anticipo: '$11.256.000', cuota: '$378.264', description: 'La Fiat Strada Freedom CD.' },
        { brand: 'peugeot', name: '208 Allure MT', price: '$36.180.000', plan: 'Easy 70/30 • 120 Cuotas', anticipo: '$10.854.000', cuota: '$266.914', description: 'El Peugeot 208 Allure MT.' },
        { brand: 'peugeot', name: '208 Allure AT', price: '$38.050.000', plan: 'Plus AT 80/20 • 84 Cuotas', anticipo: '$7.610.000', cuota: '$385.054', description: 'El Peugeot 208 Allure AT.' },
        { brand: 'peugeot', name: '2008 Active', price: '$44.510.000', plan: '2008 80/20 • 84 Cuotas', anticipo: '$8.902.000', cuota: '$513.527', description: 'El Peugeot 2008 Active.' },
        { brand: 'peugeot', name: '2008 Allure T200', price: '$48.760.000', plan: '70/30 • 84 Cuotas', anticipo: '$9.752.000', cuota: '$562.561', description: 'El Peugeot 2008 Allure T200.' },
        { brand: 'peugeot', name: 'Partner Confort 1.6 HDI', price: '$38.070.000', plan: '70/30 • 84 Cuotas', anticipo: '$11.421.000', cuota: '$388.421', description: 'El Peugeot Partner Confort 1.6 HDI.' },
        { brand: 'peugeot', name: 'Expert L3 HDI 120', price: '$57.500.000', plan: '70/30 • 84 Cuotas', anticipo: '$17.250.000', cuota: '$586.072', description: 'El Peugeot Expert L3 HDI 120.' },
        { brand: 'renault', name: 'Kwid Iconic Bitono 1.0', price: '$25.540.000', plan: '100% • 120 Cuotas', anticipo: '$7.662.000', cuota: '$214.167', description: 'El Renault Kwid Iconic Bitono 1.0.' },
        { brand: 'renault', name: 'Kardian Evolution 156 MT', price: '$36.160.000', plan: '100% • 120 Cuotas', anticipo: '$10.848.000', cuota: '$327.588', description: 'El Renault Kardian Evolution 156 MT.' },
        { brand: 'renault', name: 'Kardian Iconic 200 EDC', price: '$44.630.000', plan: '75/25 • 84 Cuotas', anticipo: '$11.157.500', cuota: '$445.131', description: 'El Renault Kardian Iconic 200 EDC.' },
        { brand: 'renault', name: 'Duster Intens 1.6 MT', price: '$41.420.000', plan: '100% • 120 Cuotas', anticipo: '$12.426.000', cuota: '$396.002', description: 'El Renault Duster Intens 1.6 MT.' },
        { brand: 'renault', name: 'Kangoo II Stepway 1.6 SCe', price: '$46.050.000', plan: '80% • 120 Cuotas', anticipo: '$9.210.000', cuota: '$353.467', description: 'La Renault Kangoo II Stepway 1.6 SCe.' },
        { brand: 'renault', name: 'Kangoo II Express 2A 1.6 SCe', price: '$41.400.000', plan: '75/25 • 120 Cuotas', anticipo: '$10.350.000', cuota: '$319.287', description: 'La Renault Kangoo II Express 2A 1.6 SCe.' },
        { brand: 'renault', name: 'Kangoo II Express 5A 1.6 SCe', price: '$45.970.000', plan: '75/25 • 120 Cuotas', anticipo: '$11.492.500', cuota: '$346.288', description: 'La Renault Kangoo II Express 5A 1.6 SCe.' },
        { brand: 'renault', name: 'Master 2.3 dCi 130', price: '$60.970.000', plan: '75/25 • 84 Cuotas', anticipo: '$15.242.500', cuota: '$630.600', description: 'El Renault Master 2.3 dCi 130.' },
        { brand: 'renault', name: 'Oroch Emotion 1.6 SCe 2WD', price: '$42.310.000', plan: '60/40 • 84 Cuotas', anticipo: '$16.924.000', cuota: '$320.803', description: 'La Renault Oroch Emotion 1.6 SCe 2WD.' },
        { brand: 'renault', name: 'Arkana Espirit Alpine', price: '$53.530.000', plan: '60/40 • 84 Cuotas', anticipo: '$21.412.000', cuota: '$443.206', description: 'El Renault Arkana Espirit Alpine.' }
    ];

    for (const v of vehicles) {
        await client.query(
            `INSERT INTO vehicles_0km (brand, name, price, plan, anticipo, cuota, description) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [v.brand, v.name, v.price, v.plan, v.anticipo, v.cuota, v.description]
        );
    }
}

// ==================== AUTH ROUTES ====================

app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        
        if (result.rows.length === 0) {
            return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
        }

        const user = result.rows[0];
        const validPassword = await bcrypt.compare(password, user.password);
        
        if (!validPassword) {
            return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
        }

        const token = jwt.sign(
            { id: user.id, username: user.username, name: user.name, role: user.role },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        res.json({ 
            token, 
            user: { id: user.id, username: user.username, name: user.name, role: user.role } 
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Error del servidor' });
    }
});

// ==================== USERS ROUTES ====================

app.get('/api/users', authMiddleware, superadminMiddleware, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, username, name, role, created_at FROM users ORDER BY id');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener usuarios' });
    }
});

app.post('/api/users', authMiddleware, superadminMiddleware, async (req, res) => {
    try {
        const { username, name, password, role } = req.body;
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const result = await pool.query(
            'INSERT INTO users (username, name, password, role) VALUES ($1, $2, $3, $4) RETURNING id, username, name, role, created_at',
            [username, name, hashedPassword, role || 'admin']
        );
        
        res.json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ error: 'El usuario ya existe' });
        }
        res.status(500).json({ error: 'Error al crear usuario' });
    }
});

app.put('/api/users/:id', authMiddleware, superadminMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { username, name, password, role } = req.body;
        
        if (password) {
            const hashedPassword = await bcrypt.hash(password, 10);
            await pool.query(
                'UPDATE users SET username = $1, name = $2, password = $3, role = $4 WHERE id = $5',
                [username, name, hashedPassword, role, id]
            );
        } else {
            await pool.query(
                'UPDATE users SET username = $1, name = $2, role = $3 WHERE id = $4',
                [username, name, role, id]
            );
        }
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Error al actualizar usuario' });
    }
});

app.delete('/api/users/:id', authMiddleware, superadminMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        
        const user = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
        if (user.rows[0]?.username === 'Luca.Caorsi') {
            return res.status(403).json({ error: 'No se puede eliminar al superadmin principal' });
        }
        
        await pool.query('DELETE FROM users WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Error al eliminar usuario' });
    }
});

// ==================== VEHICLES 0KM ROUTES ====================

app.get('/api/vehicles/0km', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM vehicles_0km ORDER BY id');
        // Parsear el campo images de JSON string a array
        const vehicles = result.rows.map(v => ({
            ...v,
            images: v.images ? JSON.parse(v.images) : []
        }));
        res.json(vehicles);
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener vehículos' });
    }
});

app.post('/api/vehicles/0km', authMiddleware, async (req, res) => {
    try {
        const { brand, name, price, plan, anticipo, cuota, description, image, images } = req.body;
        if (!brand || !name) return res.status(400).json({ error: 'Marca y modelo son requeridos' });
        
        const mainImage = images && images.length > 0 ? images[0] : (image || '');
        const imagesJson = images && images.length > 0 ? JSON.stringify(images.slice(0, 10)) : null;
        
        const result = await pool.query(
            `INSERT INTO vehicles_0km (brand, name, price, plan, anticipo, cuota, description, image, images) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            [brand, name, price, plan, anticipo, cuota, description, mainImage, imagesJson]
        );
        
        res.json({ success: true, id: result.rows[0].id });
    } catch (err) {
        console.error('Error creating 0km vehicle:', err);
        res.status(500).json({ error: 'Error al crear vehículo' });
    }
});

app.put('/api/vehicles/0km/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { price, plan, anticipo, cuota, description, image, images } = req.body;
        
        // Subir imágenes a Cloudinary
        const uploadedImages = await uploadMultipleToCloudinary(images || []);
        const mainImage = uploadedImages.length > 0 ? uploadedImages[0] : await uploadToCloudinary(image);
        
        const imagesJson = uploadedImages.length > 0 ? JSON.stringify(uploadedImages.slice(0, 10)) : null;
        
        await pool.query(
            `UPDATE vehicles_0km SET price = $1, plan = $2, anticipo = $3, cuota = $4, description = $5, image = $6, images = $7, updated_at = CURRENT_TIMESTAMP WHERE id = $8`,
            [price, plan, anticipo, cuota, description, mainImage, imagesJson, id]
        );
        
        res.json({ success: true });
    } catch (err) {
        console.error('Error updating vehicle:', err);
        res.status(500).json({ error: 'Error al actualizar vehículo' });
    }
});

app.delete('/api/vehicles/0km/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM vehicles_0km WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        console.error('Error deleting vehicle:', err);
        res.status(500).json({ error: 'Error al eliminar vehículo' });
    }
});

// ==================== VEHICLES USADOS ROUTES ====================

app.get('/api/vehicles/usados', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM vehicles_usados ORDER BY id DESC');
        // Parsear el campo images de JSON string a array
        const vehicles = result.rows.map(v => ({
            ...v,
            images: v.images ? JSON.parse(v.images) : []
        }));
        res.json(vehicles);
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener vehículos usados' });
    }
});

app.post('/api/vehicles/usados', authMiddleware, async (req, res) => {
    try {
        const { brand, modelo, year, km, price, description, image, images } = req.body;
        
        // Subir imágenes a Cloudinary
        const uploadedImages = await uploadMultipleToCloudinary(images || []);
        const mainImage = uploadedImages.length > 0 ? uploadedImages[0] : await uploadToCloudinary(image);
        
        const imagesJson = uploadedImages.length > 0 ? JSON.stringify(uploadedImages.slice(0, 10)) : null;
        
        const result = await pool.query(
            `INSERT INTO vehicles_usados (brand, modelo, year, km, price, description, image, images) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [brand, modelo, year, km, price, description, mainImage, imagesJson]
        );
        
        const vehicle = result.rows[0];
        vehicle.images = vehicle.images ? JSON.parse(vehicle.images) : [];
        
        res.json(vehicle);
    } catch (err) {
        console.error('Error creating usado:', err);
        res.status(500).json({ error: 'Error al crear vehículo usado' });
    }
});

app.put('/api/vehicles/usados/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { brand, modelo, year, km, price, description, image, images } = req.body;
        
        // Subir imágenes a Cloudinary
        const uploadedImages = await uploadMultipleToCloudinary(images || []);
        const mainImage = uploadedImages.length > 0 ? uploadedImages[0] : await uploadToCloudinary(image);
        
        const imagesJson = uploadedImages.length > 0 ? JSON.stringify(uploadedImages.slice(0, 10)) : null;
        
        await pool.query(
            `UPDATE vehicles_usados SET brand = $1, modelo = $2, year = $3, km = $4, price = $5, description = $6, image = $7, images = $8, updated_at = CURRENT_TIMESTAMP WHERE id = $9`,
            [brand, modelo, year, km, price, description, mainImage, imagesJson, id]
        );
        
        res.json({ success: true });
    } catch (err) {
        console.error('Error updating usado:', err);
        res.status(500).json({ error: 'Error al actualizar vehículo usado' });
    }
});

app.delete('/api/vehicles/usados/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM vehicles_usados WHERE id = $1', [id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Error al eliminar vehículo usado' });
    }
});

// ==================== MERCADO PAGO - CHECKOUT PRO ====================

app.post('/api/mp/crear-pago', async (req, res) => {
    try {
        const { titulo, monto, vehiculoId } = req.body;

        if (!titulo || !monto) {
            return res.status(400).json({ error: 'Faltan datos: titulo y monto son requeridos' });
        }

        const result = await mpPreference.create({
            body: {
                items: [
                    {
                        id: vehiculoId || 'cuota-1',
                        title: `GoldPlan - Cuota 1: ${titulo}`,
                        quantity: 1,
                        unit_price: Number(monto),
                        currency_id: 'ARS'
                    }
                ],
                back_urls: {
                    success: 'https://goldplan.com.ar/?pago=ok',
                    failure: 'https://goldplan.com.ar/?pago=error',
                    pending: 'https://goldplan.com.ar/?pago=pendiente'
                },
                auto_return: 'approved',
                statement_descriptor: 'GOLDPLAN',
                external_reference: `cuota1-${vehiculoId || Date.now()}`
            }
        });

        res.json({
            init_point: result.init_point,
            id: result.id
        });

    } catch (error) {
        console.error('Error MP:', error);
        res.status(500).json({ error: 'Error al crear el pago' });
    }
});

// ==================== MIGRATE IMAGES TO CLOUDINARY ====================

app.post('/api/migrate-images', authMiddleware, async (req, res) => {
    try {
        let migrated = 0;
        
        // Migrar 0km
        const vehicles0km = await pool.query('SELECT id, image, images FROM vehicles_0km');
        for (const v of vehicles0km.rows) {
            let needsUpdate = false;
            let newImage = v.image;
            let newImages = v.images ? JSON.parse(v.images) : [];
            
            if (v.image && v.image.startsWith('data:image')) {
                newImage = await uploadToCloudinary(v.image);
                needsUpdate = true;
            }
            
            if (newImages.length > 0) {
                const migratedImages = [];
                for (const img of newImages) {
                    if (img.startsWith('data:image')) {
                        const url = await uploadToCloudinary(img);
                        if (url) migratedImages.push(url);
                        needsUpdate = true;
                    } else {
                        migratedImages.push(img);
                    }
                }
                newImages = migratedImages;
            }
            
            if (needsUpdate) {
                await pool.query(
                    'UPDATE vehicles_0km SET image = $1, images = $2 WHERE id = $3',
                    [newImage, JSON.stringify(newImages), v.id]
                );
                migrated++;
            }
        }
        
        // Migrar usados
        const usados = await pool.query('SELECT id, image, images FROM vehicles_usados');
        for (const v of usados.rows) {
            let needsUpdate = false;
            let newImage = v.image;
            let newImages = v.images ? JSON.parse(v.images) : [];
            
            if (v.image && v.image.startsWith('data:image')) {
                newImage = await uploadToCloudinary(v.image);
                needsUpdate = true;
            }
            
            if (newImages.length > 0) {
                const migratedImages = [];
                for (const img of newImages) {
                    if (img.startsWith('data:image')) {
                        const url = await uploadToCloudinary(img);
                        if (url) migratedImages.push(url);
                        needsUpdate = true;
                    } else {
                        migratedImages.push(img);
                    }
                }
                newImages = migratedImages;
            }
            
            if (needsUpdate) {
                await pool.query(
                    'UPDATE vehicles_usados SET image = $1, images = $2 WHERE id = $3',
                    [newImage, JSON.stringify(newImages), v.id]
                );
                migrated++;
            }
        }
        
        res.json({ success: true, migrated });
    } catch (err) {
        console.error('Error migrando imágenes:', err);
        res.status(500).json({ error: 'Error al migrar imágenes' });
    }
});

// ==================== CONFIG ROUTES ====================

app.get('/api/config', async (req, res) => {
    try {
        const result = await pool.query('SELECT key, value FROM config');
        const config = {};
        result.rows.forEach(row => { config[row.key] = row.value; });
        res.json(config);
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener configuración' });
    }
});

app.post('/api/config', authMiddleware, async (req, res) => {
    try {
        const { whatsapp, telefono, horarios } = req.body;
        
        const upsert = async (key, value) => {
            await pool.query(
                `INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
                [key, value]
            );
        };
        
        if (whatsapp) await upsert('whatsapp', whatsapp);
        if (telefono) await upsert('telefono', telefono);
        if (horarios) await upsert('horarios', horarios);
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Error al guardar configuración' });
    }
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Error no manejado:', err.message);
    if (!res.headersSent) {
        res.status(500).json({ error: 'Error interno del servidor' });
    }
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err.message);
});

// Start server
initDB().then(() => {
    const server = app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
    
    // Timeout para requests largas (2 minutos)
    server.timeout = 120000;
    server.keepAliveTimeout = 65000;
});