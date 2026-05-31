import express, { Request, Response } from 'express';
import { Pool } from 'pg';
import cors from 'cors';

const app = express();
app.use(cors());
app.use(express.json());

// Configuración de conexión para Supabase / Neon u otra BD gratuita
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres.lwnmlvtsulspgflodura:[Algosalvaje26]@aws-1-us-west-2.pooler.supabase.com:5432/postgres',
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// ==========================================
// ENDPOINTS DE METADATOS Y ÁREAS DINÁMICAS
// ==========================================

// Obtener todas las áreas de inventario activas
app.get('/api/areas', async (req: Request, res: Response) => {
    try {
        const result = await pool.query('SELECT * FROM inventario_areas ORDER BY nombre_area ASC');
        res.json(result.rows);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// Crear una nueva área lógica desde la Web o Móvil
app.post('/api/areas', async (req: Request, res: Response) => {
    const { nombre_area } = req.body;
    if (!nombre_area) return res.status(400).json({ error: 'Nombre de área requerido' });
    try {
        const result = await pool.query(
            'INSERT INTO inventario_areas (nombre_area) VALUES ($1) RETURNING *',
            [nombre_area.toUpperCase().trim()]
        );
        res.status(201).json(result.rows[0]);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// Obtener el esquema dinámico actual de las columnas
app.get('/api/metadata', async (req: Request, res: Response) => {
    try {
        const result = await pool.query('SELECT * FROM inventario_metadata WHERE visible = true');
        res.json(result.rows);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// Añadir una nueva columna dinámica desde el Dashboard Web
app.post('/api/metadata', async (req: Request, res: Response) => {
    const { nombre_campo, etiqueta, tipo_dato } = req.body;
    try {
        const result = await pool.query(
            'INSERT INTO inventario_metadata (nombre_campo, etiqueta, tipo_dato) VALUES ($1, $2, $3) RETURNING *',
            [nombre_campo.toLowerCase().replace(/\s+/g, '_'), etiqueta, tipo_dato || 'texto']
        );
        res.status(201).json(result.rows[0]);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// ENDPOINTS CRUD PARA ITEMS DE INVENTARIO
// ==========================================

// Listar todos los ítems (opcional filtrar por área)
app.get('/api/items', async (req: Request, res: Response) => {
    const { area } = req.query;
    try {
        let query = 'SELECT * FROM inventario_items';
        const params = [];
        if (area) {
            query += ' WHERE area_inventario = $1';
            params.push(area);
        }
        query += ' ORDER BY creado_en DESC';
        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// Crear un único registro
app.post('/api/items', async (req: Request, res: Response) => {
    const { area_inventario, tienda, usuario, dispositivo, marca, modelo, serie, placa_sinsa, campos_dinamicos } = req.body;
    try {
        const result = await pool.query(
            `INSERT INTO inventario_items 
            (area_inventario, tienda, usuario, dispositivo, marca, modelo, serie, placa_sinsa, campos_dinamicos) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
            [area_inventario, tienda, usuario, dispositivo, marca, modelo, serie, placa_sinsa, campos_dinamicos || {}]
        );
        res.status(201).json(result.rows[0]);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// Modificar un registro existente
app.put('/api/items/:id', async (req: Request, res: Response) => {
    const { id } = req.params;
    const { tienda, usuario, dispositivo, marca, modelo, serie, placa_sinsa, campos_dinamicos } = req.body;
    try {
        const result = await pool.query(
            `UPDATE inventario_items SET 
            tienda = $1, usuario = $2, dispositivo = $3, marca = $4, modelo = $5, serie = $6, 
            placa_sinsa = $7, campos_dinamicos = $8, actualizado_en = CURRENT_TIMESTAMP 
            WHERE id = $9 RETURNING *`,
            [tienda, usuario, dispositivo, marca, modelo, serie, placa_sinsa, campos_dinamicos, id]
        );
        res.json(result.rows[0]);
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// Eliminar un registro
app.delete('/api/items/:id', async (req: Request, res: Response) => {
    const { id } = req.params;
    try {
        await pool.query('DELETE FROM inventario_items WHERE id = $1', [id]);
        res.json({ message: 'Registro eliminado exitosamente' });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// ENDPOINT DE SINCRONIZACIÓN OFFLINE MASIVA (BATCH UPSERT)
// ==========================================
app.post('/api/items/sync', async (req: Request, res: Response) => {
    const { items } = req.body; // Array de registros generados offline
    if (!Array.isArray(items)) return res.status(400).json({ error: 'Formato inválido' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const syncResults = [];

        for (const item of items) {
            const query = `
                INSERT INTO inventario_items 
                (area_inventario, tienda, usuario, dispositivo, marca, modelo, serie, placa_sinsa, campos_dinamicos)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                ON CONFLICT (serie) 
                DO UPDATE SET 
                    placa_sinsa = EXCLUDED.placa_sinsa,
                    campos_dinamicos = inventario_items.campos_dinamicos || EXCLUDED.campos_dinamicos,
                    actualizado_en = CURRENT_TIMESTAMP
                RETURNING id;
            `;
            const values = [
                item.area_inventario, item.tienda, item.usuario, item.dispositivo,
                item.marca, item.modelo, item.serie, item.placa_sinsa, item.campos_dinamicos || {}
            ];
            const resItem = await client.query(query, values);
            syncResults.push(resItem.rows[0]);
        }

        await client.query('COMMIT');
        res.json({ success: true, registros_sincronizados: syncResults.length });
    } catch (err: any) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor de Inventario corriendo en puerto ${PORT}`));