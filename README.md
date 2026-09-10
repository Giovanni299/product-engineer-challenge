# Product Engineer Challenge

A multi-service e-commerce API built with NestJS, PostgreSQL, and Redis.

## Architecture

This application uses:
- **NestJS** - Backend framework
- **PostgreSQL** - Primary database
- **Redis** - Caching layer
- **TypeORM** - Database ORM

## Setup

### Prerequisites

- Node.js 20+
- pnpm
- Docker and Docker Compose

### Installation

```bash
pnpm install
```

### Create environment file

```bash
cp .env.sample .env
```

### Start services

```bash
docker-compose up -d
```

### Run the application

```bash
pnpm run start:dev
```

The API will be available at `http://localhost:3000`

### Testing the API

Run the automated test suite with:

```bash
pnpm test
```

A Postman collection (`Zubale.postman_collection.json`, in the repo root) is also included to exercise every endpoint manually against `http://localhost:3000`. Import it into Postman and use the collection variables (`userId`, `productId`, `categoryId`, `orderId`) to chain requests without hardcoding IDs.

## Modules

- **AppModule** — root module: sets up `ConfigModule`, the TypeORM Postgres connection (`synchronize: true`, fine for dev, risky in prod), and a global Redis-backed `CacheModule`. Wires together the three domain modules below.
- **UsersModule** — manages the customers that place orders.
- **ProductsModule** — manages products and their (self-referencing, tree-shaped) categories.
- **OrdersModule** — order lifecycle: creation, stock reservation, simulated payment, cancellation.

## API Endpoints

### Users

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /users | Get all users. Cached in Redis (`users:all`, 60s) |
| GET | /users/:id | Get user by ID. Cached in Redis (`user:{id}`, 60s) |
| POST | /users | Create a user. Invalidates `users:all` cache |
| DELETE | /users/:id | Delete a user. Invalidates both cache keys |

### Products

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /products | Get all products, with their category |
| GET | /products/:id | Get product by ID |
| GET | /products/search?q=term | Case-insensitive search over name/description (in-memory filter), cached per query |
| POST | /products | Create a product |
| POST | /products/batch | Bulk-touch `updatedAt` for a list of `productIds`; failures on individual IDs are logged and skipped |
| DELETE | /products/:id | Delete a product |

### Categories

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /categories | Get all categories, with `parent`/`children` |
| GET | /categories/:id | Get category by ID, with `parent`, `children`, `products` |
| GET | /categories/:id/tree | Recursively builds the full ancestor + descendant tree |
| POST | /categories | Create a category |

### Orders

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /orders | Get all orders, with user/items/product |
| GET | /orders?userId=1 | Get orders by user |
| GET | /orders/:id | Get order by ID |
| GET | /orders/:id/full | Same as above, also includes each item's product category |
| POST | /orders | Create an order: validates the user, then for each item atomically decrements stock (conditional `UPDATE ... WHERE stock >= quantity` inside a DB transaction) and computes the total |
| POST | /orders/:id/pay | Simulates payment via a mock service (10% random failure, 3 retries); on success moves the order to `CONFIRMED` |
| PATCH | /orders/:id/status | Sets the order status directly (no transition validation) |
| POST | /orders/:id/cancel | Only allowed while `PENDING`; restores stock for each item and sets status to `CANCELLED` |

## Data Models

### User

| Field | Type | Description |
|-------|------|-------------|
| id | number | Unique identifier |
| email | string | User email (unique) |
| name | string | User name |
| isActive | boolean | Account status |
| createdAt | Date | Creation timestamp |

### Product

| Field | Type | Description |
|-------|------|-------------|
| id | number | Unique identifier |
| name | string | Product name |
| description | string | Product description |
| price | decimal | Product price |
| stock | number | Available stock |
| isAvailable | boolean | Availability status |
| categoryId | number | Category reference |

### Category

| Field | Type | Description |
|-------|------|-------------|
| id | number | Unique identifier |
| name | string | Category name |
| description | string | Category description |
| parentId | number | Parent category (for hierarchy) |

### Order

| Field | Type | Description |
|-------|------|-------------|
| id | number | Unique identifier |
| status | enum | pending, confirmed, shipped, delivered, cancelled |
| total | decimal | Order total |
| userId | number | User reference |
| items | array | Order items |
| createdAt | Date | Creation timestamp |

### OrderItem

| Field | Type | Description |
|-------|------|-------------|
| id | number | Unique identifier |
| orderId | number | Order reference |
| productId | number | Product reference |
| quantity | number | Quantity ordered |
| price | decimal | Product price frozen at purchase time |

## Database Schema & Relationships

```
users (id PK, email UNIQUE, name, is_active, created_at)
   │ 1
   │
   │ N
orders (id PK, status ENUM, total, user_id FK -> users.id, created_at)
   │ 1
   │
   │ N
order_items (id PK, order_id FK -> orders.id, product_id FK -> products.id, quantity, price)
   │ N
   │
   │ 1
products (id PK, name, description, price, stock, is_available, category_id FK -> categories.id, created_at, updated_at)
   │ N
   │
   │ 1
categories (id PK, name, description, parent_id FK -> categories.id, self-referencing)
```

- **User 1—N Order**: a user can place many orders.
- **Order 1—N OrderItem**: an order has many line items (cascade save, eager loaded).
- **OrderItem N—1 Product**: each item references a product and stores the `price` at the time of purchase.
- **Product N—1 Category**: each product optionally belongs to one category.
- **Category self-referencing (parent/children)**: categories form an N-level tree.

Stock updates use a conditional `UPDATE` (not read-then-write) to avoid race conditions when concurrent orders touch the same product. Payment processing is an in-memory mock — there's no real payment gateway integration or persisted payment-transaction record.

## Features

- **Caching**: Redis caching for improved performance
- **Validation**: Request validation using class-validator
- **Relations**: Complex entity relationships
- **Batch Processing**: Bulk operations support
- **Payment Processing**: Simulated payment with retry logic

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| PORT | Application port | 3000 |
| DB_HOST | PostgreSQL host | localhost |
| DB_PORT | PostgreSQL port | 5432 |
| DB_USER | PostgreSQL user | postgres |
| DB_PASSWORD | PostgreSQL password | postgres |
| DB_NAME | Database name | challengedb |
| REDIS_HOST | Redis host | localhost |
| REDIS_PORT | Redis port | 6379 |
| REDIS_DB | Redis database number | 1 |
