import { pool } from '../db';
import Handlebars from 'handlebars';
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { logger } from '../utils/logger';

export interface NotificationTemplate {
  id: string;
  name: string;
  slug: string;
  channel: 'email' | 'sms' | 'push';
  subject?: string;  // for email
  bodyTemplate: string;
  htmlTemplate?: string;  // for email - HTML version
  variables: string[];  // expected template variables
  organizationId?: string;  // null = system-wide template
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// Cache compiled templates in memory
// TODO: invalidate cache when templates are updated
// Right now you have to restart the service to pick up template changes
const templateCache: Map<string, HandlebarsTemplateDelegate> = new Map();
const subjectCache: Map<string, HandlebarsTemplateDelegate> = new Map();

export class TemplateModel {
  /**
   * Get a template by slug
   * First checks the database for org-specific overrides, then falls back
   * to file-based templates
   */
  async getTemplate(slug: string, orgId?: string): Promise<{
    subject?: string;
    body: string;
    html?: string;
  } | null> {
    // Check DB for org-specific template override
    if (orgId) {
      try {
        const result = await pool.query(
          `SELECT * FROM notification_templates
           WHERE slug = $1 AND organization_id = $2 AND is_active = true`,
          [slug, orgId]
        );

        if (result.rows.length > 0) {
          return {
            subject: result.rows[0].subject,
            body: result.rows[0].body_template,
            html: result.rows[0].html_template,
          };
        }
      } catch {
        // Table might not exist yet - fall through to file-based templates
      }
    }

    // Check DB for system-wide template
    try {
      const result = await pool.query(
        `SELECT * FROM notification_templates
         WHERE slug = $1 AND organization_id IS NULL AND is_active = true`,
        [slug]
      );

      if (result.rows.length > 0) {
        return {
          subject: result.rows[0].subject,
          body: result.rows[0].body_template,
          html: result.rows[0].html_template,
        };
      }
    } catch {
      // Table might not exist - use file-based templates
    }

    // Fall back to file-based Handlebars template
    return this.loadFileTemplate(slug);
  }

  /**
   * Render a template with data
   */
  renderTemplate(templateStr: string, data: Record<string, any>): string {
    const cacheKey = templateStr.substring(0, 50); // use prefix as cache key (hacky)

    let compiled = templateCache.get(cacheKey);
    if (!compiled) {
      compiled = Handlebars.compile(templateStr);
      templateCache.set(cacheKey, compiled);
    }

    return compiled(data);
  }

  /**
   * Render subject line
   */
  renderSubject(subjectTemplate: string, data: Record<string, any>): string {
    let compiled = subjectCache.get(subjectTemplate);
    if (!compiled) {
      compiled = Handlebars.compile(subjectTemplate);
      subjectCache.set(subjectTemplate, compiled);
    }
    return compiled(data);
  }

  /**
   * Load template from filesystem
   */
  private loadFileTemplate(slug: string): { subject?: string; body: string; html?: string } | null {
    const templatesDir = path.join(__dirname, '..', 'templates');
    const hbsPath = path.join(templatesDir, `${slug}.hbs`);

    if (!existsSync(hbsPath)) {
      logger.warn('Template file not found', { slug, path: hbsPath });
      return null;
    }

    try {
      const content = readFileSync(hbsPath, 'utf-8');

      // Parse frontmatter-style metadata from template
      // Format: {{!-- subject: Your appointment reminder --}}
      let subject: string | undefined;
      const subjectMatch = content.match(/\{\{!--\s*subject:\s*(.+?)\s*--\}\}/);
      if (subjectMatch) {
        subject = subjectMatch[1];
      }

      return {
        subject,
        body: content,
        html: content, // same for now - we don't have separate text/html versions
      };
    } catch (error: any) {
      logger.error('Failed to load template file', { slug, error: error.message });
      return null;
    }
  }

  /**
   * Create or update a template in the database
   */
  async upsertTemplate(template: Partial<NotificationTemplate>): Promise<NotificationTemplate> {
    const result = await pool.query(
      `INSERT INTO notification_templates (
        id, name, slug, channel, subject, body_template, html_template,
        variables, organization_id, is_active, created_at, updated_at
      ) VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, true, NOW(), NOW()
      )
      ON CONFLICT (slug, organization_id) DO UPDATE SET
        name = COALESCE($1, notification_templates.name),
        subject = COALESCE($4, notification_templates.subject),
        body_template = COALESCE($5, notification_templates.body_template),
        html_template = COALESCE($6, notification_templates.html_template),
        variables = COALESCE($7, notification_templates.variables),
        updated_at = NOW()
      RETURNING *`,
      [
        template.name,
        template.slug,
        template.channel || 'email',
        template.subject,
        template.bodyTemplate,
        template.htmlTemplate,
        JSON.stringify(template.variables || []),
        template.organizationId || null,
      ]
    );

    // Clear cache for this template
    // TODO: this only clears the local instance cache
    // Other instances will still have the old version
    templateCache.clear();
    subjectCache.clear();

    return result.rows[0];
  }
}

// Register Handlebars helpers
Handlebars.registerHelper('formatDate', function(date: string, format: string) {
  // Very basic date formatting
  // TODO: use luxon or date-fns for proper formatting
  if (!date) return '';
  const d = new Date(date);
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
});

Handlebars.registerHelper('formatTime', function(time: string) {
  if (!time) return '';
  const d = new Date(time);
  return d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
});

Handlebars.registerHelper('formatCurrency', function(amount: number) {
  if (amount === undefined || amount === null) return '$0.00';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount / 100); // amounts stored in cents
});

Handlebars.registerHelper('eq', function(a: any, b: any) {
  return a === b;
});

Handlebars.registerHelper('capitalize', function(str: string) {
  if (!str) return '';
  return str.charAt(0).toUpperCase() + str.slice(1).toLowerCase();
});
