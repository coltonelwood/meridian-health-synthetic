import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Pool } from 'pg';

const router = Router();

const getPool = (): Pool => (global as any).__pgPool;
const getLogger = () => (global as any).__logger;

/**
 * Document templates for clinical documentation.
 *
 * Templates are pre-formatted document structures that providers
 * can use to create clinical notes, discharge summaries, etc.
 * They support variable substitution (e.g., {{patient_name}})
 * and sections that can be toggled on/off.
 *
 * The template engine is pretty basic - just string replacement.
 * We talked about using a real template engine (Handlebars, etc.)
 * but this works for our current needs and nobody's complained.
 *
 * Templates are org-specific (each organization can customize theirs)
 * with system-level defaults.
 */

interface TemplateVariable {
  name: string;
  label: string;
  type: 'text' | 'date' | 'select' | 'multiline' | 'boolean';
  required: boolean;
  default_value?: string;
  options?: string[]; // for select type
}

/**
 * GET /api/v1/templates
 * List available templates
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const { category, org_id, active_only } = req.query;

    let query = 'SELECT id, name, category, description, document_type, org_id, is_system, is_active, version, created_at, updated_at FROM document_templates WHERE 1=1';
    const params: any[] = [];
    let paramIndex = 1;

    if (category) {
      query += ` AND category = $${paramIndex++}`;
      params.push(category);
    }

    if (org_id) {
      // Show org-specific templates AND system templates
      query += ` AND (org_id = $${paramIndex++} OR is_system = true)`;
      params.push(org_id);
    } else {
      // No org specified - show system templates only
      query += ' AND is_system = true';
    }

    if (active_only !== 'false') {
      query += ' AND is_active = true';
    }

    query += ' ORDER BY category, name ASC';

    const result = await pool.query(query, params);

    res.json({ data: result.rows });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/templates/:id
 * Get a specific template with its content
 */
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const { id } = req.params;

    const result = await pool.query(
      'SELECT * FROM document_templates WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }

    const template = result.rows[0];

    // Parse variables from template content
    const variables = extractTemplateVariables(template.content);

    res.json({
      data: {
        ...template,
        variables,
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/templates
 * Create a new template
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const logger = getLogger();
    const { name, category, description, document_type, content, org_id, sections } = req.body;

    if (!name || !content) {
      return res.status(400).json({ error: 'name and content are required' });
    }

    const id = uuidv4();

    await pool.query(`
      INSERT INTO document_templates (
        id, name, category, description, document_type,
        content, sections, org_id, is_system, is_active,
        version, created_at, updated_at, created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, 1, NOW(), NOW(), $10)
    `, [
      id, name, category || 'general', description || null,
      document_type || 'clinical_note', content,
      JSON.stringify(sections || []),
      org_id || null, !org_id, // system template if no org
      (req as any).user?.id || 'system',
    ]);

    logger.info('Template created', { templateId: id, name });

    res.status(201).json({
      data: { id, name },
      message: 'Template created successfully',
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/v1/templates/:id
 * Update a template
 */
router.put('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const { id } = req.params;
    const { name, description, content, sections, is_active } = req.body;

    const existing = await pool.query(
      'SELECT * FROM document_templates WHERE id = $1',
      [id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }

    // Don't allow editing system templates unless admin
    if (existing.rows[0].is_system) {
      // TODO: check admin role
      getLogger().warn('System template being edited', { templateId: id });
    }

    await pool.query(`
      UPDATE document_templates SET
        name = COALESCE($1, name),
        description = COALESCE($2, description),
        content = COALESCE($3, content),
        sections = COALESCE($4, sections),
        is_active = COALESCE($5, is_active),
        version = version + 1,
        updated_at = NOW()
      WHERE id = $6
    `, [name, description, content, sections ? JSON.stringify(sections) : null, is_active, id]);

    res.json({ message: 'Template updated', id });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/templates/:id/render
 * Render a template with variables
 */
router.post('/:id/render', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const pool = getPool();
    const { id } = req.params;
    const { variables, include_sections } = req.body;

    const result = await pool.query(
      'SELECT * FROM document_templates WHERE id = $1 AND is_active = true',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Template not found or inactive' });
    }

    const template = result.rows[0];
    let rendered = template.content;

    // Replace variables
    if (variables && typeof variables === 'object') {
      for (const [key, value] of Object.entries(variables)) {
        // Replace both {{key}} and {{ key }} patterns
        rendered = rendered.replace(
          new RegExp(`\\{\\{\\s*${escapeRegExp(key)}\\s*\\}\\}`, 'g'),
          String(value || '')
        );
      }
    }

    // Handle sections (toggle on/off)
    if (template.sections && include_sections) {
      const sections = typeof template.sections === 'string'
        ? JSON.parse(template.sections)
        : template.sections;

      for (const section of sections) {
        const sectionTag = `<!-- section:${section.id} -->`;
        const sectionEndTag = `<!-- /section:${section.id} -->`;

        if (include_sections[section.id] === false) {
          // Remove the section
          const regex = new RegExp(
            `${escapeRegExp(sectionTag)}[\\s\\S]*?${escapeRegExp(sectionEndTag)}`,
            'g'
          );
          rendered = rendered.replace(regex, '');
        } else {
          // Keep section content, remove section tags
          rendered = rendered.replace(sectionTag, '').replace(sectionEndTag, '');
        }
      }
    }

    // Clean up any unreplaced variables
    // Leave them in for debugging in dev, remove in prod
    if (process.env.NODE_ENV === 'production') {
      rendered = rendered.replace(/\{\{.*?\}\}/g, '');
    }

    res.json({
      data: {
        rendered_content: rendered,
        template_name: template.name,
        template_version: template.version,
        rendered_at: new Date().toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
});

function extractTemplateVariables(content: string): TemplateVariable[] {
  const variableRegex = /\{\{\s*(\w+)\s*\}\}/g;
  const variables: TemplateVariable[] = [];
  const seen = new Set<string>();

  let match;
  while ((match = variableRegex.exec(content)) !== null) {
    const name = match[1];
    if (seen.has(name)) continue;
    seen.add(name);

    // Try to infer type from variable name
    let type: TemplateVariable['type'] = 'text';
    if (name.includes('date') || name.includes('dob')) type = 'date';
    if (name.includes('notes') || name.includes('description') || name.includes('assessment')) type = 'multiline';

    variables.push({
      name,
      label: name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
      type,
      required: true, // conservative default
    });
  }

  return variables;
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default router;
