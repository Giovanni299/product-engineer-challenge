# Fixing Report

Investigación y corrección de las causas raíz de los síntomas reportados por los usuarios. Cada bug fue reproducido y verificado en vivo contra Postgres y Redis reales (Docker), antes y después del fix.

---

## 1. Requests extremadamente lentos o que nunca terminan

**Archivo:** `src/orders/orders.service.ts` — `processPayment()`

**Error encontrado:** el retry del pago tenía `maxRetries = 1000`, con una espera de 100ms entre cada intento fallido. En el peor caso (baja probabilidad pero posible, dado que cada intento tiene 10% de falla simulada), esto podía tomar más de 100 segundos en un solo request, bloqueando la respuesta al cliente.

**Ajuste aplicado:** se redujo `maxRetries` a `3` y, al agotar los intentos, se lanza un `BadRequestException` con un mensaje claro que incluye el número de intentos y el error original, en vez de dejar el request colgado o propagar un error crudo.

---

## 2. Datos inconsistentes o stock incorrecto (race condition)

**Archivos:** `src/orders/orders.service.ts` — `create()` / `cancel()`, `src/products/products.service.ts` — `updateStock()`

**Error encontrado:** al crear una orden, el descuento de stock se hacía así:

```ts
this.productsService.updateStock(product.id, product.stock - itemDto.quantity);
```

- No tenía `await` (fire-and-forget): la respuesta se devolvía antes de que el stock se actualizara.
- `updateStock` hacía lectura-luego-escritura (`findOne` + `save`) sin ninguna atomicidad, por lo que dos órdenes concurrentes podían leer el mismo stock y ambas descontarlo, dejando el stock final incorrecto (vendiendo más de lo disponible).
- Tampoco había transacción: si un ítem fallaba por falta de stock a mitad de la creación de la orden, la orden y los ítems ya guardados quedaban huérfanos en la base de datos.

**Verificación del bug:** se dispararon 10 órdenes concurrentes de cantidad 2 contra un producto con stock=10. Sin el fix esto corrompe el stock (posibles ventas por encima del disponible).

**Ajuste aplicado:**
- Se agregaron los métodos atómicos `decrementStock()` e `incrementStock()` en `products.service.ts`, implementados con un `UPDATE` condicional vía query builder (`WHERE stock >= :quantity`), evitando el patrón read-then-write.
- `create()` y `cancel()` en `orders.service.ts` ahora corren dentro de una transacción (`manager.transaction(...)`), de modo que si un ítem falla por falta de stock, toda la orden se revierte (rollback completo, sin datos huérfanos).

**Resultado verificado:** con stock=10, las 10 órdenes concurrentes de cantidad 2 dejan exactamente 5 órdenes exitosas y el stock final en 0, sin corrupción. Una orden con un ítem sin stock suficiente revierte completamente (el stock del primer ítem no cambia y no queda orden creada).

---

## 3. Cache behavior does not match expectations

**Archivo:** `src/products/products.service.ts` — `searchProducts()`

**Error encontrado:** la cache key era un string fijo, `'product-search'`, sin importar el término de búsqueda:

```ts
const cacheKey = 'product-search';
```

Esto causaba que la primera búsqueda cacheara sus resultados, y cualquier búsqueda posterior con un término distinto recibiera esos mismos resultados cacheados incorrectamente durante el TTL de 60s.

**Ajuste aplicado:** la cache key ahora incluye el query normalizado:

```ts
const cacheKey = `product-search:${query.trim().toLowerCase()}`;
```

**Resultado verificado:** buscar `"wid"` y luego `"zzz"` devuelve resultados distintos y correctos (antes, `"zzz"` hubiera devuelto el resultado cacheado de `"wid"`).

---

## 4. Errores vagos o engañosos

**Archivo:** `src/orders/orders.service.ts` — `getOrderWithFullDetails()`

**Error encontrado:** el código construía intencionalmente una referencia circular:

```ts
const enriched: any = { ...order };
enriched.user = { ...order.user };
enriched.user.latestOrder = enriched;

return JSON.parse(JSON.stringify(enriched));
```

`JSON.stringify` sobre una estructura circular lanza `TypeError: Converting circular structure to JSON`, un error genérico que no explica el problema real al llamador de `GET /orders/:id/full`.

**Ajuste aplicado:** se eliminó la asignación circular (no aportaba ningún valor funcional) y el método retorna directamente la entidad cargada con sus relaciones.

**Resultado verificado:** `GET /orders/:id/full` responde correctamente con el detalle completo de la orden, sin errores.

---

## 5. Bug adicional encontrado por inspección: árbol de categorías

**Archivo:** `src/products/products.service.ts` — `buildCategoryTree()`

**Error encontrado:** `findCategory()` solo carga un nivel de relaciones (`parent`, `children`, `products`). `buildCategoryTree()` asumía que `category.parent.parent` también estaba cargado, y para jerarquías de 2+ niveles terminaba llamando la función recursiva con `undefined`, lanzando un `TypeError` genérico al acceder a `category.id` sobre `undefined`.

**Ajuste aplicado:** se cambió la condición de recursión de `if (category.parentId)` a `if (category.parent)`, evitando el crash cuando el nivel superior de la jerarquía no viene cargado.

---

## 6. Configuración de Redis ignorada

**Archivo:** `src/app.module.ts`

**Error encontrado:** el `CacheModule` tenía `db: 0` hardcodeado, ignorando la variable de entorno `REDIS_DB` (que en `.env.sample` está definida como `1`). Esto podía causar inconsistencias de caché si distintos entornos esperaban usar bases de Redis distintas.

**Ajuste aplicado:**

```ts
db: parseInt(process.env.REDIS_DB || '0', 10),
```

---

## Tests unitarios agregados

Se agregaron dos archivos de tests unitarios (servicios instanciados directamente con dependencias mockeadas, sin necesidad de DB/Redis):

**`src/products/products.service.spec.ts`**
- `decrementStock`: descuenta stock cuando hay suficiente; lanza `BadRequestException` en vez de permitir sobreventa cuando no alcanza; lanza `NotFoundException` si el producto no existe; usa el `EntityManager` transaccional cuando se le pasa uno.
- `incrementStock`: restaura stock correctamente; lanza `NotFoundException` si el producto no existe.
- `searchProducts`: la cache key incluye el término de búsqueda; búsquedas distintas no reutilizan la key del término anterior; el query se normaliza (trim + lowercase) para reusar cache entre variantes equivalentes.
- `getCategoryTree`: no crashea cuando el abuelo de una categoría no viene cargado; una categoría raíz no incluye la clave `parent`.

**`src/orders/orders.service.spec.ts`**
- `create`: descuenta stock de cada ítem a través del manager transaccional y calcula el total correctamente; si un ítem falla por falta de stock, se detiene sin tocar los ítems restantes (rollback, sin datos huérfanos).
- `cancel`: restaura el stock de cada ítem vía el manager transaccional y marca la orden como `cancelled`; rechaza con `BadRequestException` sin tocar stock si la orden no está `pending`; rechaza con `NotFoundException` si no existe.
- `processPayment`: confirma la orden en el primer intento exitoso; agota los reintentos acotados (3, no 1000) y lanza `BadRequestException` con mensaje claro en vez de colgarse.
- `getOrderWithFullDetails`: retorna la orden cargada sin lanzar error de estructura circular y sin perder tipos (p. ej. `Date` se mantiene como `Date`, ya no pasa por `JSON.stringify`); lanza `NotFoundException` si no existe.

Total: 21 tests, todos en verde (`npx jest`).

## Validación

- `nest build` compila sin errores de TypeScript.
- `jest` pasa el test suite completo (21/21), incluyendo los tests nuevos.
- `eslint` sobre los archivos de test nuevos: 0 errores (solo warnings de `no-unsafe-argument`, ya configurado como advertencia a nivel de proyecto).
- Se levantaron contenedores reales de Postgres y Redis (`docker-compose up -d`) y se corrió la app con `nest start`, probando manualmente:
  - Creación de usuario, categoría y producto.
  - Búsqueda de productos con distintos términos (fix de caché).
  - 10 órdenes concurrentes sobre el mismo producto (fix de race condition de stock).
  - Pago de orden (fix de retries).
  - `GET /orders/:id/full` (fix de JSON circular).
  - Cancelación de orden y restauración de stock.
  - Árbol de categorías.
  - Orden con fallo de stock a mitad de camino (fix de transacción/rollback).
