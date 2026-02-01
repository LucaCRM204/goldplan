const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cloudinary = require('cloudinary').v2;
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
        { brand: 'volkswagen', name: 'T-Cross Trendline 200 TSI AT MY26', price: '$52.851.350', plan: '70/30 • 84 Cuotas', anticipo: '$15.855.405', cuota: '$504.100', description: 'El Volkswagen T-Cross Trendline 200 TSI AT es el SUV urbano líder del segmento. Su motor TSI 200 turbo de 1.0 litros entrega 116 CV con transmisión automática de 6 velocidades, ofreciendo una conducción ágil y eficiente. Cuenta con tecnología VW Play con pantalla de 10 pulgadas, conectividad completa y navegación GPS. El equipamiento de seguridad incluye 6 airbags, control de tracción, asistente de frenado post-colisión y cámara de retroceso. Amplio espacio interior con baúl de 420 litros expandible.' },
        { brand: 'volkswagen', name: 'Nivus Trendline 200 TSI AT MY26', price: '$45.775.000', plan: '70/30 • 84 Cuotas', anticipo: '$13.732.500', cuota: '$436.605', description: 'El Volkswagen Nivus es un innovador SUV Coupé que combina diseño deportivo con funcionalidad. Motor 200 TSI turbo de 128 CV con transmisión automática de 6 velocidades. Destaca su techo solar panorámico, sistema de sonido Beats premium y pantalla táctil de 10 pulgadas con VW Play. El diseño coupé no sacrifica espacio: cuenta con baúl de 415 litros. Equipamiento de serie incluye faros full LED, sensores de lluvia y luz, control crucero adaptativo y sistema de frenado autónomo de emergencia.' },
        { brand: 'volkswagen', name: 'Amarok Trendline TDI MT 4x2 MY25', price: '$58.255.550', plan: '60/40 • 84 Cuotas', anticipo: '$23.302.220', cuota: '$508.493', description: 'La Volkswagen Amarok Trendline TDI es la pick-up de alta gama que combina capacidad de trabajo con confort premium. Motor TDI turbodiesel 2.0 de 180 CV con caja manual de 6 velocidades. Capacidad de carga de 1.104 kg y arrastre de hasta 3.100 kg. El interior ofrece asientos ergonómicos, climatizador bizona, sistema multimedia con pantalla de 8 pulgadas y conectividad completa. Chasis reforzado, suspensión independiente delantera y sistema de estabilidad de remolque para máxima versatilidad.' },
        { brand: 'volkswagen', name: 'Taos Comfortline 250 TSI AT', price: '$56.942.500', plan: '60/40 • 84 Cuotas', anticipo: '$22.777.000', cuota: '$497.032', description: 'El Volkswagen Taos Comfortline es el SUV mediano premium que redefine el confort. Motor 250 TSI turbo de 150 CV con transmisión automática Tiptronic de 6 velocidades. Amplio espacio interior para 5 pasajeros con baúl de 498 litros. Equipamiento Comfortline incluye techo solar panorámico, asientos tapizados en cuero ecológico, climatizador bizona Climatronic, cuadro digital Active Info Display y sistema de sonido premium. Seguridad completa con 6 airbags, control de crucero adaptativo y detector de fatiga.' },
        { brand: 'fiat', name: 'Titano Endurance MT 4x4', price: '$52.890.000', plan: '70/30 • 84 Cuotas', anticipo: '$15.867.000', cuota: '$533.219', description: 'La nueva Fiat Titano Endurance MT 4x4 es la pick-up que combina robustez con tecnología italiana. Motor turbodiesel 2.2 de 200 CV con tracción 4x4 seleccionable y caja manual de 6 velocidades. Capacidad de carga superior a 1.200 kg y arrastre de 3.500 kg. Equipamiento Endurance incluye diferencial trasero autoblocante, control de descenso, protección inferior y ganchos de amarre. Interior con pantalla táctil de 10.1 pulgadas, climatizador automático y asientos con ajuste lumbar. Ideal para trabajo pesado y aventura off-road.' },
        { brand: 'fiat', name: 'Titano Freedom MT 4WD', price: '$58.240.000', plan: '60/40 • 84 Cuotas', anticipo: '$23.296.000', cuota: '$509.434', description: 'La Fiat Titano Freedom MT 4WD es la versión tope de gama que eleva el concepto de pick-up premium. Motor turbodiesel 2.2 de 200 CV con tracción integral permanente 4WD y diferencial central. Equipamiento Freedom incluye asientos de cuero con calefacción, pantalla multimedia de 10.1 pulgadas con navegación, cámara 360° con visión bird-view, techo solar y sistema de audio premium de 8 parlantes. Suspensión trasera Multilink para mayor confort y estabilidad. Tecnología de asistencia incluye frenado autónomo, alerta de colisión y monitoreo de punto ciego.' },
        { brand: 'fiat', name: 'Argo Drive 1.3 MT', price: '$29.780.000', plan: '70/30 • 84 Cuotas', anticipo: '$8.934.000', cuota: '$300.232', description: 'El Fiat Argo Drive 1.3 MT es el hatchback italiano que conquista por su diseño y eficiencia. Motor Fire 1.3 de 99 CV con caja manual de 5 velocidades, logrando excelente economía de combustible. Diseño exterior italiano con líneas fluidas, faros con firma LED y llantas de aleación de 15 pulgadas. Equipamiento incluye aire acondicionado, dirección asistida eléctrica, conectividad Bluetooth, comando de audio al volante y computadora de viaje. Amplio baúl de 300 litros y configuración de asientos rebatibles para mayor versatilidad.' },
        { brand: 'fiat', name: 'Cronos Drive 1.3 MT5 Pack Plus', price: '$37.020.000', plan: '80/20 • 84 Cuotas', anticipo: '$7.404.000', cuota: '$422.627', description: 'El Fiat Cronos Drive 1.3 MT5 Pack Plus es el sedán compacto que maximiza espacio y tecnología. Motor 1.3 Firefly de 99 CV con transmisión manual de 5 velocidades y modo Eco para mayor eficiencia. El Pack Plus agrega sistema multimedia Uconnect con pantalla de 7 pulgadas, Android Auto y Apple CarPlay, cámara de retroceso y sensores de estacionamiento. Baúl líder del segmento con 525 litros. Interior espacioso para 5 pasajeros con climatizador manual, alzacristales eléctricos en las cuatro puertas y cierre centralizado con comando a distancia.' },
        { brand: 'fiat', name: 'Fastback Turbo 270 AT6', price: '$45.310.000', plan: '60/40 • 84 Cuotas', anticipo: '$18.124.000', cuota: '$396.333', description: 'El Fiat Fastback Turbo 270 AT6 es el SUV Coupé que fusiona deportividad con sofisticación. Motor turbo T270 de 185 CV con transmisión automática de 6 velocidades y levas en el volante para cambios manuales. Diseño coupé distintivo con techo descendente, spoiler trasero integrado y llantas de 18 pulgadas. Interior premium con asientos tapizados en cuero, techo solar panorámico eléctrico, cuadro de instrumentos digital de 7 pulgadas y sistema Uconnect con pantalla de 10.1 pulgadas. Modos de conducción Auto, Sport y Off-road para adaptarse a cada situación.' },
        { brand: 'fiat', name: 'Mobi Trekking 1.0', price: '$27.070.000', plan: '80/20 • 84 Cuotas', anticipo: '$5.414.000', cuota: '$309.036', description: 'El Fiat Mobi Trekking 1.0 es el city car aventurero que destaca en la ciudad. Motor 1.0 Firefly de 75 CV, el más eficiente de su categoría con bajo consumo de combustible. Look Trekking con suspensión elevada, protecciones plásticas, barras de techo y diseño bicolor exclusivo. Compactas dimensiones ideales para maniobras urbanas y estacionamiento. Equipamiento incluye aire acondicionado, dirección asistida, sistema de audio con Bluetooth y USB, y computadora de viaje. Radio con comandos al volante y cierre centralizado con alarma.' },
        { brand: 'fiat', name: 'Toro Freedom T270 AT6 4x2', price: '$47.250.000', plan: '70/30 • 84 Cuotas', anticipo: '$14.175.000', cuota: '$476.359', description: 'La Fiat Toro Freedom T270 AT6 4x2 es la pick-up mediana que equilibra capacidad de trabajo con confort diario. Motor turbo T270 de 185 CV con caja automática de 6 velocidades y 4 modos de conducción: Auto, Sport, Lama y Arena. Capacidad de carga de 650 kg y arrastre de 2.000 kg. Equipamiento Freedom incluye pantalla Uconnect de 9 pulgadas con navegación, climatizador automático bizona, asientos de cuero y sistema keyless. Caja de carga con iluminación LED, toma 12V y sistema de anclaje versátil Multi-Flex.' },
        { brand: 'fiat', name: 'Pulse Drive 1.3L MT', price: '$36.670.000', plan: '70/30 • 84 Cuotas', anticipo: '$11.001.000', cuota: '$369.695', description: 'El Fiat Pulse Drive 1.3L MT es el SUV compacto con el mejor equipamiento de su categoría. Motor 1.3 Firefly de 107 CV con transmisión manual de 5 velocidades y bajo consumo. Diseño SUV moderno con posición de manejo elevada, llantas de 16 pulgadas y barras de techo. Pantalla Uconnect de 8.4 pulgadas con Android Auto y Apple CarPlay inalámbrico. Seguridad completa con 6 airbags, control de estabilidad, asistente de arranque en pendiente y alerta de cambio de carril. Amplio baúl de 370 litros con piso plano y ganchos de sujeción.' },
        { brand: 'fiat', name: 'Fiorino Endurance 1.4L', price: '$29.310.000', plan: '70/30 • 84 Cuotas', anticipo: '$8.793.000', cuota: '$295.494', description: 'El Fiat Fiorino Endurance 1.4L es el utilitario compacto ideal para el trabajo diario. Motor 1.4 Fire EVO de 88 CV optimizado para uso intensivo con bajo costo de mantenimiento. Capacidad de carga de 650 kg y volumen de 3.3 m³ con puerta lateral corrediza y puertas traseras asimétricas de apertura 180°. Versión Endurance incluye protección de carga, separador de cabina, iluminación en área de carga y preparación para rack de techo. Conducción ágil ideal para entregas urbanas con radio con Bluetooth y aire acondicionado disponibles.' },
        { brand: 'fiat', name: 'Strada Freedom CD', price: '$37.520.000', plan: '70/30 • 84 Cuotas', anticipo: '$11.256.000', cuota: '$378.264', description: 'La Fiat Strada Freedom CD es la pick-up compacta más vendida de Argentina y Sudamérica. Configuración cabina doble con capacidad para 5 pasajeros y motor 1.3 Firefly de 107 CV con caja manual de 5 velocidades. Caja de carga de 844 litros con capacidad de 720 kg y sistema Multi-Flex que permite extender el espacio. Equipamiento Freedom incluye pantalla de 7 pulgadas con Android Auto, climatizador manual, llantas de aleación de 15 pulgadas y barras de techo. Ideal para quienes necesitan versatilidad: trabajo durante la semana y paseos en familia los fines de semana.' },
        { brand: 'peugeot', name: '208 Allure MT', price: '$36.180.000', plan: 'Easy 70/30 • 120 Cuotas', anticipo: '$10.854.000', cuota: '$266.914', description: 'El Peugeot 208 Allure MT es el hatchback premium que revolucionó el segmento con su i-Cockpit. Puesto de conducción único con volante compacto, cuadro de instrumentos elevado para mejor visualización y pantalla táctil central de 7 pulgadas. Motor 1.6 VTi de 115 CV con transmisión manual de 5 velocidades. Diseño exterior distintivo con faros LED con firma luminosa de 3 garras, parrilla sin marco y líneas esculpidas. Equipamiento Allure incluye climatizador automático, sensores de estacionamiento traseros, cámara de retroceso y control crucero. Seguridad con 6 airbags y alerta de cambio de carril.' },
        { brand: 'peugeot', name: '208 Allure AT', price: '$38.050.000', plan: 'Plus AT 80/20 • 84 Cuotas', anticipo: '$7.610.000', cuota: '$385.054', description: 'El Peugeot 208 Allure AT lleva la experiencia de conducción premium al siguiente nivel con transmisión automática de 6 velocidades. El revolucionario i-Cockpit 3D proyecta información holográfica en el cuadro de instrumentos para una lectura más intuitiva. Motor 1.6 VTi de 115 CV que combina potencia con eficiencia. Tecnología avanzada incluye reconocimiento de señales de tránsito, frenado de emergencia automático y alerta de atención del conductor. Interior refinado con tapizado premium, espejo interior sin marco y ambient lighting personalizable. Conectividad completa con Mirror Screen para Android Auto y Apple CarPlay.' },
        { brand: 'peugeot', name: '2008 Active', price: '$44.510.000', plan: '2008 80/20 • 84 Cuotas', anticipo: '$8.902.000', cuota: '$513.527', description: 'El Peugeot 2008 Active es el SUV compacto que combina el ADN Peugeot con versatilidad urbana. Posición de manejo elevada con el exclusivo i-Cockpit para mayor control y visibilidad. Motor 1.6 VTi de 115 CV con transmisión manual de 5 velocidades. Diseño robusto con protecciones laterales, barras de techo y llantas de aleación de 17 pulgadas. Equipamiento incluye pantalla táctil de 7 pulgadas, climatizador manual, sensores de estacionamiento y cámara trasera. Seguridad certificada con 6 airbags, control de estabilidad y tracción, y asistente de arranque en pendiente. Baúl de 434 litros ampliable.' },
        { brand: 'peugeot', name: '2008 Allure T200', price: '$48.760.000', plan: '70/30 • 84 Cuotas', anticipo: '$9.752.000', cuota: '$562.561', description: 'El Peugeot 2008 Allure T200 es la versión tope del SUV compacto con motorización turbo de alto rendimiento. Motor PureTech T200 turbo de 165 CV con transmisión automática de 6 velocidades, logrando aceleración de 0-100 km/h en 8.2 segundos. i-Cockpit 3D con cuadro digital de alta definición y pantalla táctil de 10 pulgadas con navegación conectada. Equipamiento Allure incluye techo panorámico, asientos AGR ergonómicos, climatizador bizona y sistema de audio premium Focal. Tecnología de asistencia con control crucero adaptativo, frenado autónomo de emergencia y reconocimiento de peatones.' },
        { brand: 'peugeot', name: 'Partner Confort 1.6 HDI', price: '$38.070.000', plan: '70/30 • 84 Cuotas', anticipo: '$11.421.000', cuota: '$388.421', description: 'El Peugeot Partner Confort 1.6 HDI es el utilitario versátil que adapta su configuración a cada necesidad. Motor HDI turbodiesel de 90 CV reconocido por su durabilidad y bajo consumo. Capacidad de carga de 850 kg con volumen de hasta 4.1 m³ en versión larga. Configuración flexible permite transportar objetos de hasta 3.25 metros de largo con asiento del acompañante rebatible. Puerta lateral corrediza y puertas traseras con apertura de 180°. Versión Confort incluye aire acondicionado, dirección asistida, radio con Bluetooth y computadora de viaje. Ideal para profesionales que necesitan espacio y confiabilidad.' },
        { brand: 'peugeot', name: 'Expert L3 HDI 120', price: '$57.500.000', plan: '70/30 • 84 Cuotas', anticipo: '$17.250.000', cuota: '$586.072', description: 'El Peugeot Expert L3 HDI 120 es el furgón profesional de gran capacidad para flotas exigentes. Motor BlueHDI 120 CV con transmisión manual de 6 velocidades, eficiente y con bajo costo operativo. Versión L3 extendida ofrece volumen de carga de hasta 6.6 m³ y capacidad de 1.400 kg. Altura interior de 1.40 metros permite trabajar de pie. Dos puertas laterales corredizas y puertas traseras con apertura de 250°. Puesto de conducción con asiento BOSE ergonómico, pantalla táctil de 7 pulgadas y cámara trasera con visión de carga. Sistema Grip Control para tracción mejorada en superficies difíciles.' },
        { brand: 'renault', name: 'Kwid Iconic Bitono 1.0', price: '$25.540.000', plan: '100% • 120 Cuotas', anticipo: '$7.662.000', cuota: '$214.167', description: 'El Renault Kwid Iconic Bitono 1.0 es el city car que maximiza personalidad y equipamiento al mejor precio. Diseño bitono exclusivo con techo en color contrastante y detalles cromados. Motor 1.0 SCe de 66 CV con transmisión manual de 5 velocidades, extremadamente eficiente en consumo. Equipamiento Iconic incluye pantalla Media Evolution de 8 pulgadas con Android Auto y Apple CarPlay, climatizador manual, alzacristales eléctricos y cierre centralizado. Diseño compacto de 3.73 metros ideal para ciudad con radio de giro de solo 4.8 metros. Baúl de 290 litros ampliable con asientos rebatibles.' },
        { brand: 'renault', name: 'Kardian Evolution 156 MT', price: '$36.160.000', plan: '100% • 120 Cuotas', anticipo: '$10.848.000', cuota: '$328.944', description: 'El Renault Kardian Evolution 156 MT es el nuevo SUV que marca una nueva era para la marca. Motor 1.0 turbo TCe de 156 CV, el más potente de su segmento, con caja manual de 6 velocidades. Diseño exterior impactante con nueva identidad de marca, faros LED con firma luminosa en C y parrilla iluminada. Interior completamente rediseñado con pantalla multimedia OpenR Link de 8 pulgadas vertical, cuadro digital de 7 pulgadas y cargador inalámbrico. Equipamiento Evolution incluye climatizador automático, sensores de estacionamiento, cámara trasera y control crucero. Modos de conducción Eco, Normal y Sport.' },
        { brand: 'renault', name: 'Kardian Iconic 200 EDC', price: '$44.630.000', plan: '75/25 • 84 Cuotas', anticipo: '$11.157.500', cuota: '$445.131', description: 'El Renault Kardian Iconic 200 EDC es la versión tope de gama del revolucionario SUV con motorización de alto rendimiento. Motor 1.3 turbo TCe de 200 CV con caja automática EDC de doble embrague y 7 velocidades. Aceleración de 0-100 km/h en 8.5 segundos. Equipamiento Iconic agrega techo solar panorámico, cámara 360° con visión bird-view, asientos de cuero con calefacción, sistema de audio premium Harman Kardon y Head-Up Display. Tecnología ADAS completa con frenado autónomo de emergencia, control crucero adaptativo, centrado de carril y reconocimiento de señales. El SUV más tecnológico de Renault.' },
        { brand: 'renault', name: 'Duster Intens 1.6 MT', price: '$41.420.000', plan: '100% • 120 Cuotas', anticipo: '$12.426.000', cuota: '$396.002', description: 'El Renault Duster Intens 1.6 MT es el SUV más versátil del mercado con probada capacidad todoterreno. Motor 1.6 SCe de 115 CV con transmisión manual de 6 velocidades, confiable y económico. Distancia al piso de 210 mm, ángulo de entrada de 30° y salida de 33° para máxima capacidad off-road. Equipamiento Intens incluye pantalla multimedia Media Nav de 8 pulgadas con navegación, cámara trasera multiview, climatizador automático y sensores de estacionamiento delanteros y traseros. Sistema Multi-Sense con modos Eco, Normal y Sport. Barras de techo longitudinales y protecciones laterales. Baúl de 478 litros.' },
        { brand: 'renault', name: 'Kangoo II Stepway 1.6 SCe', price: '$46.050.000', plan: '80% • 120 Cuotas', anticipo: '$9.210.000', cuota: '$353.467', description: 'La Renault Kangoo II Stepway 1.6 SCe es la versión aventurera del icónico vehículo familiar. Look Stepway distintivo con protecciones plásticas, barras de techo, faros antiniebla y mayor altura libre al piso. Motor 1.6 SCe de 115 CV con transmisión manual de 5 velocidades. Amplio espacio interior para 5 pasajeros con configuración de asientos traseros rebatibles y deslizables. Puertas traseras corredizas para fácil acceso en espacios reducidos. Equipamiento incluye pantalla Media Nav de 7 pulgadas, climatizador manual, sensores de estacionamiento y control crucero. Ideal para familias activas.' },
        { brand: 'renault', name: 'Kangoo II Express 2A 1.6 SCe', price: '$41.400.000', plan: '75/25 • 120 Cuotas', anticipo: '$10.350.000', cuota: '$319.287', description: 'La Renault Kangoo II Express 2A 1.6 SCe es el utilitario de 2 asientos diseñado para maximizar la capacidad de carga. Motor 1.6 SCe de 115 CV confiable y económico con caja manual de 5 velocidades. Volumen de carga de 3.3 m³ con capacidad de 650 kg, líder del segmento. Mampara de separación full con ventana y puerta lateral corrediza derecha. Piso plano con tratamiento antideslizante, ganchos de amarre y iluminación LED en área de carga. Equipamiento incluye radio con Bluetooth, aire acondicionado opcional y dirección asistida. Ideal para delivery, logística urbana y pequeños emprendedores.' },
        { brand: 'renault', name: 'Kangoo II Express 5A 1.6 SCe', price: '$45.970.000', plan: '75/25 • 120 Cuotas', anticipo: '$11.492.500', cuota: '$346.288', description: 'La Renault Kangoo II Express 5A 1.6 SCe combina transporte de pasajeros con capacidad de carga en un vehículo versátil. Configuración de 5 asientos con segunda fila rebatible 60/40 que permite múltiples combinaciones de carga y pasajeros. Motor 1.6 SCe de 115 CV con transmisión manual de 5 velocidades. Capacidad mixta: hasta 5 personas o 2 personas más 2.4 m³ de carga con asientos traseros rebatidos. Puertas traseras corredizas en ambos lados para máxima accesibilidad. Equipamiento incluye pantalla multimedia, climatizador y sensores de estacionamiento. Perfecta para familias y profesionales.' },
        { brand: 'renault', name: 'Master 2.3 dCi 130', price: '$60.970.000', plan: '75/25 • 84 Cuotas', anticipo: '$15.242.500', cuota: '$630.600', description: 'El Renault Master 2.3 dCi 130 es el furgón de gran porte para operaciones de logística profesional. Motor dCi 130 de 2.3 litros turbodiesel con 130 CV, reconocido por su durabilidad y economía. Capacidad de carga de hasta 13 m³ en versión L3H2 y 1.500 kg de carga útil. Altura interior de trabajo de 1.88 metros permite operaciones de pie. Puertas traseras con apertura de 270° y puerta lateral corrediza de gran tamaño. Puesto de conducción ergonómico con asiento ajustable en altura, pantalla multimedia y cámara de retroceso. Sistema Extended Grip para tracción mejorada disponible. Ideal para mudanzas, distribución y servicios.' },
        { brand: 'renault', name: 'Oroch Emotion 1.6 SCe 2WD', price: '$42.310.000', plan: '60/40 • 84 Cuotas', anticipo: '$16.924.000', cuota: '$320.803', description: 'La Renault Oroch Emotion 1.6 SCe 2WD es la pick-up compacta con ADN de SUV Duster. Motor 1.6 SCe de 115 CV con transmisión manual de 6 velocidades y tracción 4x2. Plataforma Duster garantiza confort de conducción tipo SUV con capacidad de trabajo de pick-up. Caja de carga de 683 litros con revestimiento resistente, iluminación y toma 12V. Equipamiento Emotion incluye pantalla Media Nav de 8 pulgadas, climatizador manual, volante multifunción y llave presencial. Diseño robusto con protecciones, estribos laterales y barras deportivas en caja de carga. Capacidad de carga de 650 kg y arrastre de 1.100 kg.' },
        { brand: 'renault', name: 'Arkana Espirit Alpine', price: '$53.530.000', plan: '60/40 • 84 Cuotas', anticipo: '$21.412.000', cuota: '$443.206', description: 'El Renault Arkana Espirit Alpine es el SUV Coupé edición especial que celebra el espíritu deportivo de Alpine. Motor 1.3 turbo TCe de 160 CV con transmisión CVT X-Tronic que simula 7 velocidades. Diseño coupé distintivo con línea de techo descendente, spoiler trasero y llantas de 18 pulgadas diseño Alpine. Detalles exclusivos azul Alpine en costuras, emblemas y acentos interiores. Equipamiento incluye cuadro digital de 7 pulgadas, pantalla multimedia de 9.3 pulgadas vertical, climatizador automático bizona y sistema de audio Bose. Modo de conducción Sport+ activa respuesta más agresiva de acelerador y dirección más firme.' }
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
            
            // Migrar imagen principal si es base64
            if (v.image && v.image.startsWith('data:image')) {
                newImage = await uploadToCloudinary(v.image);
                needsUpdate = true;
            }
            
            // Migrar array de imágenes
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
