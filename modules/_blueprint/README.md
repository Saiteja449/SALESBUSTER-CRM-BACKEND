# SalesBuster CRM - Module Development Blueprint

This folder serves as the standard template for building new features and modules in the SalesBuster CRM backend (e.g. Email Marketing, Invoicing, Custom Integrations, Telephony).

## Architecture Pattern

Each module follows a clean **4-Layer Architecture**:

```
modules/<module_name>/
├── <module>.routes.js       # Route paths, HTTP methods, and middleware (auth, validateRequest)
├── <module>.controller.js   # HTTP layer: parses request, calls service, sends response
├── <module>.service.js      # Business logic & database operations (pure functions)
└── <module>.schema.js       # Zod validation schemas for body, query, and params
```

## How to Create a New Module

1. Copy this folder and rename it: `modules/<your-feature-name>/`.
2. Define input validation in `<module>.schema.js` using Zod.
3. Write pure business logic in `<module>.service.js`. Use `tenantModels` for multi-tenant isolation.
4. Call service functions from `<module>.controller.js` and return responses with `sendSuccess` or `sendPaginated`.
5. Mount your routes in `server.js`:
   ```javascript
   import myModuleRoutes from "./modules/my-feature/myFeature.routes.js";
   app.use("/api/my-feature", myModuleRoutes);
   ```

## Rules for New Modules
1. **Never use raw global models:** Always operate on `tenantModels.<Model>` obtained via `getTenantScope(req)` to preserve multi-tenant database isolation.
2. **Never catch and silence errors:** Throw standard `AppError` instances (`BadRequestError`, `NotFoundError`, etc.) or let them bubble up to `asyncHandler`.
3. **Always validate user inputs:** Wrap route handlers with `validateRequest(<schema>)`.
