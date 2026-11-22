const express = require('express');
const { AppError, query, withTransaction, insertAuditLog, isValidUuid } = require('../db');
const { authenticate, requireRole, getClientIp } = require('../auth');
const { sanitizeForRole } = require('../sanitize');

const router = express.Router();

const VALID_ROLES_ENUM = [
  'BASE_TEA', 'COFFEE', 'MILK', 'SUGAR', 'ICE', 'SYRUP', 'CUP', 'LID', 'TOPPING', 'OTHER',
];

router.use(authenticate);

router.get('/menu', async (req, res, next) => {
  try {
    const { rows: menuRows } = await query(
      `SELECT m.id, m.code, m.name, m.category, m.base_price, m.is_available,
              r.id AS recipe_id, r.version_no, r.sop_steps_json
       FROM menu_items m
       LEFT JOIN recipes r ON r.menu_item_id = m.id AND r.is_active = TRUE
       WHERE m.deleted_at IS NULL
       ORDER BY m.code ASC`
    );

    const recipeIds = menuRows.map((r) => r.recipe_id).filter(Boolean);
    const linesByRecipe = new Map();

    if (recipeIds.length > 0 && req.user.role !== 'CASHIER') {
      const { rows: lineRows } = await query(
        `SELECT rl.recipe_id, rl.item_id, ii.sku, ii.name AS item_name,
                ii.base_unit, rl.qty_base, rl.ingredient_role, ii.avg_unit_cost
         FROM recipe_lines rl
         JOIN inventory_items ii ON ii.id = rl.item_id
         WHERE rl.recipe_id = ANY($1::uuid[])
         ORDER BY rl.id ASC`,
        [recipeIds]
      );
      for (const l of lineRows) {
        if (!linesByRecipe.has(l.recipe_id)) {
          linesByRecipe.set(l.recipe_id, []);
        }
        linesByRecipe.get(l.recipe_id).push(l);
      }
    }

    const result = menuRows.map((m) => {
      let recipe = null;
      if (m.recipe_id) {
        if (req.user.role === 'CASHIER') {
          recipe = {
            id: m.recipe_id,
            version_no: m.version_no,
          };
        } else {
          const rawLines = linesByRecipe.get(m.recipe_id) || [];
          const lines = rawLines.map((l) => ({
            item_id: l.item_id,
            sku: l.sku,
            item_name: l.item_name,
            base_unit: l.base_unit,
            qty_base: l.qty_base,
            ingredient_role: l.ingredient_role,
          }));
          const estCogs = Math.round(
            rawLines.reduce((sum, l) => sum + l.qty_base * l.avg_unit_cost, 0) * 100
          ) / 100;

          recipe = {
            id: m.recipe_id,
            version_no: m.version_no,
            sop_steps: Array.isArray(m.sop_steps_json) ? m.sop_steps_json : [],
            lines,
          };
          if (req.user.role === 'OWNER') {
            recipe.est_cogs = estCogs;
          }
        }
      }

      return {
        id: m.id,
        code: m.code,
        name: m.name,
        category: m.category,
        base_price: m.base_price,
        is_available: m.is_available,
        recipe,
      };
    });

    return res.json(sanitizeForRole(result, req.user.role));
  } catch (err) {
    return next(err);
  }
});

router.patch('/menu/:id/availability', requireRole('OWNER', 'MANAGER'), async (req, res, next) => {
  try {
    const menuId = req.params.id;
    if (!isValidUuid(menuId)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'ID món không hợp lệ.');
    }
    const isAvailable = req.body?.is_available;
    if (typeof isAvailable !== 'boolean') {
      throw new AppError(400, 'VALIDATION_ERROR', 'Trường is_available phải là boolean.');
    }

    const updated = await withTransaction(async (client) => {
      const { rows: existing } = await client.query(
        `SELECT id, code, name, is_available FROM menu_items WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [menuId]
      );
      if (!existing.length) {
        throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy món trong thực đơn.');
      }

      const { rows } = await client.query(
        `UPDATE menu_items SET is_available = $1 WHERE id = $2
         RETURNING id, code, name, category, base_price, is_available`,
        [isAvailable, menuId]
      );

      await insertAuditLog(client, {
        actorId: req.user.id,
        actionCode: 'MENU_AVAILABILITY',
        entityTable: 'menu_items',
        entityId: menuId,
        oldValues: { is_available: existing[0].is_available },
        newValues: { is_available: isAvailable },
        reason: `Cập nhật trạng thái "${existing[0].name}": ${isAvailable ? 'Đang bán' : 'Hết món'}`,
        deviceIp: getClientIp(req),
      });

      return rows[0];
    });

    return res.json(updated);
  } catch (err) {
    return next(err);
  }
});

router.post('/menu/:id/recipe-version', requireRole('OWNER'), async (req, res, next) => {
  try {
    const menuId = req.params.id;
    if (!isValidUuid(menuId)) {
      throw new AppError(400, 'VALIDATION_ERROR', 'ID món không hợp lệ.');
    }

    const hasCustomLines = req.body && req.body.lines !== undefined;
    const hasCustomSop = req.body && req.body.sop_steps !== undefined;

    if (hasCustomLines) {
      if (!Array.isArray(req.body.lines) || req.body.lines.length === 0) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Danh sách định lượng (lines) không được rỗng.');
      }
      for (const l of req.body.lines) {
        if (!isValidUuid(l.item_id) || typeof l.qty_base !== 'number' || !Number.isFinite(l.qty_base) || l.qty_base <= 0) {
          throw new AppError(400, 'VALIDATION_ERROR', 'Mỗi dòng định lượng phải có item_id hợp lệ và qty_base > 0.');
        }
        if (!VALID_ROLES_ENUM.includes(l.ingredient_role)) {
          throw new AppError(400, 'VALIDATION_ERROR', `ingredient_role không hợp lệ: ${l.ingredient_role}`);
        }
      }
    }

    if (hasCustomSop) {
      if (!Array.isArray(req.body.sop_steps) || req.body.sop_steps.some((s) => typeof s !== 'string')) {
        throw new AppError(400, 'VALIDATION_ERROR', 'sop_steps phải là mảng chuỗi.');
      }
    }

    const created = await withTransaction(async (client) => {
      const { rows: menuRows } = await client.query(
        `SELECT id, name FROM menu_items WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
        [menuId]
      );
      if (!menuRows.length) {
        throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy món trong thực đơn.');
      }

      const { rows: activeRecipes } = await client.query(
        `SELECT * FROM recipes WHERE menu_item_id = $1 AND is_active = TRUE FOR UPDATE`,
        [menuId]
      );
      if (!activeRecipes.length) {
        throw new AppError(404, 'NOT_FOUND', 'Không tìm thấy công thức đang hoạt động cho món này.');
      }
      const oldRecipe = activeRecipes[0];

      // Deactivate old recipe before inserting new active recipe (partial unique index uq_recipes_active_menu)
      await client.query(`UPDATE recipes SET is_active = FALSE WHERE id = $1`, [oldRecipe.id]);

      const { rows: maxVerRows } = await client.query(
        `SELECT COALESCE(MAX(version_no), 0) AS max_ver FROM recipes WHERE menu_item_id = $1`,
        [menuId]
      );
      const newVersionNo = Number(maxVerRows[0].max_ver) + 1;

      let linesToInsert;
      if (hasCustomLines) {
        linesToInsert = req.body.lines.map((l) => ({
          item_id: l.item_id,
          qty_base: l.qty_base,
          ingredient_role: l.ingredient_role,
        }));
      } else {
        const { rows: oldLines } = await client.query(
          `SELECT item_id, qty_base, ingredient_role FROM recipe_lines WHERE recipe_id = $1 ORDER BY id ASC`,
          [oldRecipe.id]
        );
        linesToInsert = oldLines;
      }

      // Compute calculated_cogs from inventory_items.avg_unit_cost
      const itemIds = [...new Set(linesToInsert.map((l) => l.item_id))];
      const { rows: itemRows } = await client.query(
        `SELECT id, sku, name, base_unit, avg_unit_cost FROM inventory_items WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL`,
        [itemIds]
      );
      if (itemRows.length !== itemIds.length) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Một hoặc nhiều nguyên liệu trong công thức không tồn tại.');
      }
      const itemMap = new Map(itemRows.map((i) => [i.id, i]));

      const calculatedCogs = Math.round(
        linesToInsert.reduce((sum, l) => sum + l.qty_base * itemMap.get(l.item_id).avg_unit_cost, 0) * 100
      ) / 100;

      const sopSteps = hasCustomSop ? req.body.sop_steps : oldRecipe.sop_steps_json;

      const { rows: newRecipeRows } = await client.query(
        `INSERT INTO recipes (
           menu_item_id, version_no, is_active, standard_yield_base,
           calculated_cogs, sop_steps_json, image_url, created_by
         ) VALUES ($1, $2, TRUE, $3, $4, $5::jsonb, $6, $7)
         RETURNING id, menu_item_id, version_no, is_active, standard_yield_base, calculated_cogs, sop_steps_json, effective_from`,
        [
          menuId,
          newVersionNo,
          oldRecipe.standard_yield_base,
          calculatedCogs,
          JSON.stringify(sopSteps),
          oldRecipe.image_url,
          req.user.id,
        ]
      );
      const newRecipe = newRecipeRows[0];

      const insertedLines = [];
      for (const l of linesToInsert) {
        await client.query(
          `INSERT INTO recipe_lines (recipe_id, item_id, qty_base, ingredient_role)
           VALUES ($1, $2, $3, $4)`,
          [newRecipe.id, l.item_id, l.qty_base, l.ingredient_role]
        );
        const it = itemMap.get(l.item_id);
        insertedLines.push({
          item_id: l.item_id,
          sku: it.sku,
          item_name: it.name,
          base_unit: it.base_unit,
          qty_base: l.qty_base,
          ingredient_role: l.ingredient_role,
        });
      }

      await insertAuditLog(client, {
        actorId: req.user.id,
        actionCode: 'BOM_VERSION_BUMP',
        entityTable: 'recipes',
        entityId: newRecipe.id,
        oldValues: { recipe_id: oldRecipe.id, version_no: oldRecipe.version_no },
        newValues: { recipe_id: newRecipe.id, version_no: newVersionNo, calculated_cogs: calculatedCogs },
        reason: `Phát hành công thức v${newVersionNo} cho ${menuRows[0].name} (từ v${oldRecipe.version_no})`,
        deviceIp: getClientIp(req),
      });

      return {
        id: newRecipe.id,
        menu_item_id: newRecipe.menu_item_id,
        version_no: newRecipe.version_no,
        is_active: newRecipe.is_active,
        calculated_cogs: newRecipe.calculated_cogs,
        est_cogs: newRecipe.calculated_cogs,
        sop_steps: Array.isArray(newRecipe.sop_steps_json) ? newRecipe.sop_steps_json : [],
        effective_from: newRecipe.effective_from,
        lines: insertedLines,
      };
    });

    return res.status(201).json(created);
  } catch (err) {
    if (err.code === '23505') {
      return next(new AppError(409, 'CONFLICT', 'Trùng lặp dòng nguyên liệu trong công thức.'));
    }
    return next(err);
  }
});

router.get('/modifiers', async (req, res, next) => {
  try {
    const { rows: mods } = await query(
      `SELECT id, group_name, name, price_delta
       FROM modifiers
       WHERE is_active = TRUE
       ORDER BY group_name ASC, name ASC`
    );

    const modIds = mods.map((m) => m.id);
    const rulesByMod = new Map();

    if (modIds.length > 0) {
      const { rows: rules } = await query(
        `SELECT modifier_id, action_type, target_ingredient_role, target_item_id, value_num, replace_with_item_id
         FROM modifier_recipe_rules
         WHERE modifier_id = ANY($1::uuid[])
         ORDER BY id ASC`,
        [modIds]
      );
      for (const r of rules) {
        if (!rulesByMod.has(r.modifier_id)) {
          rulesByMod.set(r.modifier_id, []);
        }
        rulesByMod.get(r.modifier_id).push({
          action_type: r.action_type,
          target_ingredient_role: r.target_ingredient_role,
          target_item_id: r.target_item_id,
          value_num: r.value_num,
          replace_with_item_id: r.replace_with_item_id,
        });
      }
    }

    const result = mods.map((m) => ({
      id: m.id,
      group_name: m.group_name,
      name: m.name,
      price_delta: m.price_delta,
      rules: rulesByMod.get(m.id) || [],
    }));

    return res.json(result);
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
