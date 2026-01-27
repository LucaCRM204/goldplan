const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'goldplan-secret-key-2026';

// Database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

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

        // Vehicles 0km table
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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Vehicles usados table
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
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
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
        { brand: 'volkswagen', name: 'Tera Trend MSI MT MY26', price: '$36.391.350', plan: '70/30 • 84 Cuotas', anticipo: '$10.917.405', cuota: '$347.103', description: 'Nuevo SUV compacto de Volkswagen con motorización MSI de alta eficiencia.' },
        { brand: 'volkswagen', name: 'T-Cross Trendline 200 TSI AT MY26', price: '$52.851.350', plan: '70/30 • 84 Cuotas', anticipo: '$15.855.405', cuota: '$504.100', description: 'El SUV urbano líder. Motor TSI 200 turbo con transmisión automática.' },
        { brand: 'volkswagen', name: 'Nivus Trendline 200 TSI AT MY26', price: '$45.775.000', plan: '70/30 • 84 Cuotas', anticipo: '$13.732.500', cuota: '$436.605', description: 'Innovador SUV Coupé. Motor 200 TSI turbo y pantalla táctil de 10".' },
        { brand: 'volkswagen', name: 'Amarok Trendline TDI MT 4x2 MY25', price: '$58.255.550', plan: '60/40 • 84 Cuotas', anticipo: '$23.302.220', cuota: '$508.493', description: 'Pick-up de alta gama con motor TDI turbodiesel.' },
        { brand: 'volkswagen', name: 'Taos Comfortline 250 TSI AT', price: '$56.942.500', plan: '60/40 • 84 Cuotas', anticipo: '$22.777.000', cuota: '$497.032', description: 'SUV mediano premium con motor 250 TSI de 150 CV.' },
        { brand: 'fiat', name: 'Titano Endurance MT 4x4', price: '$52.890.000', plan: '70/30 • 84 Cuotas', anticipo: '$15.867.000', cuota: '$533.219', description: 'Nueva pick-up Fiat con motor turbodiésel de 200 CV y tracción 4x4.' },
        { brand: 'fiat', name: 'Titano Freedom MT 4WD', price: '$58.240.000', plan: '60/40 • 84 Cuotas', anticipo: '$23.296.000', cuota: '$509.434', description: 'Versión tope de gama con tracción integral y equipamiento premium.' },
        { brand: 'fiat', name: 'Argo Drive 1.3 MT', price: '$29.780.000', plan: '70/30 • 84 Cuotas', anticipo: '$8.934.000', cuota: '$300.232', description: 'Hatchback italiano con motor Fire 1.3.' },
        { brand: 'fiat', name: 'Cronos Drive 1.3 MT5 Pack Plus', price: '$37.020.000', plan: '80/20 • 84 Cuotas', anticipo: '$7.404.000', cuota: '$422.627', description: 'Sedán compacto con sistema multimedia y baúl de 525 litros.' },
        { brand: 'fiat', name: 'Fastback Turbo 270 AT6', price: '$45.310.000', plan: '60/40 • 84 Cuotas', anticipo: '$18.124.000', cuota: '$396.333', description: 'SUV Coupé con motor turbo de 185 CV.' },
        { brand: 'fiat', name: 'Mobi Trekking 1.0', price: '$27.070.000', plan: '80/20 • 84 Cuotas', anticipo: '$5.414.000', cuota: '$309.036', description: 'City car aventurero con diseño Trekking.' },
        { brand: 'fiat', name: 'Toro Freedom T270 AT6 4x2', price: '$47.250.000', plan: '70/30 • 84 Cuotas', anticipo: '$14.175.000', cuota: '$476.359', description: 'Pick-up mediana con motor turbo T270 de 185 CV.' },
        { brand: 'fiat', name: 'Pulse Drive 1.3L MT', price: '$36.670.000', plan: '70/30 • 84 Cuotas', anticipo: '$11.001.000', cuota: '$369.695', description: 'SUV compacto con motor 1.3 Firefly de 107 CV.' },
        { brand: 'fiat', name: 'Fiorino Endurance 1.4L', price: '$29.310.000', plan: '70/30 • 84 Cuotas', anticipo: '$8.793.000', cuota: '$295.494', description: 'Utilitario compacto con capacidad de 650 kg.' },
        { brand: 'fiat', name: 'Strada Freedom CD', price: '$37.520.000', plan: '70/30 • 84 Cuotas', anticipo: '$11.256.000', cuota: '$378.264', description: 'La pick-up compacta más vendida de Argentina.' },
        { brand: 'peugeot', name: '208 Allure MT', price: '$36.180.000', plan: 'Easy 70/30 • 120 Cuotas', anticipo: '$10.854.000', cuota: '$266.914', description: 'Hatchback premium con i-Cockpit.' },
        { brand: 'peugeot', name: '208 Allure AT', price: '$38.050.000', plan: 'Plus AT 80/20 • 84 Cuotas', anticipo: '$7.610.000', cuota: '$385.054', description: 'Versión automática del 208 con i-Cockpit 3D.' },
        { brand: 'peugeot', name: '2008 Active', price: '$44.510.000', plan: '2008 80/20 • 84 Cuotas', anticipo: '$8.902.000', cuota: '$513.527', description: 'SUV compacto Peugeot con 6 airbags.' },
        { brand: 'peugeot', name: '2008 Allure T200', price: '$48.760.000', plan: '70/30 • 84 Cuotas', anticipo: '$9.752.000', cuota: '$562.561', description: 'Versión tope con motor turbo T200 de 165 CV.' },
        { brand: 'peugeot', name: 'Partner Confort 1.6 HDI', price: '$38.070.000', plan: '70/30 • 84 Cuotas', anticipo: '$11.421.000', cuota: '$388.421', description: 'Utilitario versátil con motor HDI turbodiesel.' },
        { brand: 'peugeot', name: 'Expert L3 HDI 120', price: '$57.500.000', plan: '70/30 • 84 Cuotas', anticipo: '$17.250.000', cuota: '$586.072', description: 'Furgón profesional con capacidad de 1.400 kg.' },
        { brand: 'renault', name: 'Kwid Iconic Bitono 1.0', price: '$25.540.000', plan: '100% • 120 Cuotas', anticipo: '$7.662.000', cuota: '$214.167', description: 'City car con diseño bitono exclusivo.' },
        { brand: 'renault', name: 'Kardian Evolution 156 MT', price: '$36.160.000', plan: '100% • 120 Cuotas', anticipo: '$10.848.000', cuota: '$328.944', description: 'Nuevo SUV Renault con motor 1.0 turbo de 156 CV.' },
        { brand: 'renault', name: 'Kardian Iconic 200 EDC', price: '$44.630.000', plan: '75/25 • 84 Cuotas', anticipo: '$11.157.500', cuota: '$445.131', description: 'Tope de gama con motor turbo de 200 CV y caja EDC.' },
        { brand: 'renault', name: 'Duster Intens 1.6 MT', price: '$41.420.000', plan: '100% • 120 Cuotas', anticipo: '$12.426.000', cuota: '$396.002', description: 'El SUV más versátil con capacidad todoterreno.' },
        { brand: 'renault', name: 'Kangoo II Stepway 1.6 SCe', price: '$46.050.000', plan: '80% • 120 Cuotas', anticipo: '$9.210.000', cuota: '$353.467', description: 'Kangoo aventurera con look Stepway.' },
        { brand: 'renault', name: 'Kangoo II Express 2A 1.6 SCe', price: '$41.400.000', plan: '75/25 • 120 Cuotas', anticipo: '$10.350.000', cuota: '$319.287', description: 'Utilitario de 2 asientos con 3.3 m³ de volumen.' },
        { brand: 'renault', name: 'Kangoo II Express 5A 1.6 SCe', price: '$45.970.000', plan: '75/25 • 120 Cuotas', anticipo: '$11.492.500', cuota: '$346.288', description: 'Utilitario de 5 asientos mixto.' },
        { brand: 'renault', name: 'Master 2.3 dCi 130', price: '$60.970.000', plan: '75/25 • 84 Cuotas', anticipo: '$15.242.500', cuota: '$630.600', description: 'Furgón de gran porte con capacidad de 13 m³.' },
        { brand: 'renault', name: 'Oroch Emotion 1.6 SCe 2WD', price: '$42.310.000', plan: '60/40 • 84 Cuotas', anticipo: '$16.924.000', cuota: '$320.803', description: 'Pick-up compacta con ADN Duster.' },
        { brand: 'renault', name: 'Arkana Espirit Alpine', price: '$53.530.000', plan: '60/40 • 84 Cuotas', anticipo: '$21.412.000', cuota: '$443.206', description: 'SUV Coupé edición Alpine con motor 1.3 turbo.' }
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
        
        // Prevent deleting the main superadmin
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
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener vehículos' });
    }
});

app.put('/api/vehicles/0km/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { price, plan, anticipo, cuota, description, image } = req.body;
        
        await pool.query(
            `UPDATE vehicles_0km SET price = $1, plan = $2, anticipo = $3, cuota = $4, description = $5, image = $6, updated_at = CURRENT_TIMESTAMP WHERE id = $7`,
            [price, plan, anticipo, cuota, description, image, id]
        );
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Error al actualizar vehículo' });
    }
});

// ==================== VEHICLES USADOS ROUTES ====================

app.get('/api/vehicles/usados', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM vehicles_usados ORDER BY id DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: 'Error al obtener vehículos usados' });
    }
});

app.post('/api/vehicles/usados', authMiddleware, async (req, res) => {
    try {
        const { brand, modelo, year, km, price, description, image } = req.body;
        
        const result = await pool.query(
            `INSERT INTO vehicles_usados (brand, modelo, year, km, price, description, image) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [brand, modelo, year, km, price, description, image]
        );
        
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: 'Error al crear vehículo usado' });
    }
});

app.put('/api/vehicles/usados/:id', authMiddleware, async (req, res) => {
    try {
        const { id } = req.params;
        const { brand, modelo, year, km, price, description, image } = req.body;
        
        await pool.query(
            `UPDATE vehicles_usados SET brand = $1, modelo = $2, year = $3, km = $4, price = $5, description = $6, image = $7, updated_at = CURRENT_TIMESTAMP WHERE id = $8`,
            [brand, modelo, year, km, price, description, image, id]
        );
        
        res.json({ success: true });
    } catch (err) {
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

// Start server
initDB().then(() => {
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });
});
