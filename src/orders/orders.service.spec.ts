/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { OrdersService } from './orders.service';
import { OrderStatus } from './order.entity';

function createFakeManager() {
  let nextId = 100;
  return {
    create: jest.fn((_entity: any, data: any) => ({ ...data })),
    save: jest.fn((data: any) => {
      if (!data.id) {
        data.id = nextId++;
      }
      return Promise.resolve(data);
    }),
    findOne: jest.fn(),
  };
}

describe('OrdersService', () => {
  let service: OrdersService;
  let ordersRepository: any;
  let orderItemsRepository: any;
  let usersService: any;
  let productsService: any;
  let cacheManager: any;
  let fakeManager: ReturnType<typeof createFakeManager>;

  beforeEach(() => {
    fakeManager = createFakeManager();

    ordersRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((data) => data),
      save: jest.fn((data) => Promise.resolve(data)),
      manager: {
        transaction: jest.fn((cb: any) => cb(fakeManager)),
      },
    };

    orderItemsRepository = {
      create: jest.fn((data) => data),
      save: jest.fn((data) => Promise.resolve(data)),
    };

    usersService = {
      findOne: jest.fn().mockResolvedValue({ id: 1, email: 'a@test.com' }),
    };

    productsService = {
      findOne: jest.fn(),
      decrementStock: jest.fn().mockResolvedValue(undefined),
      incrementStock: jest.fn().mockResolvedValue(undefined),
    };

    cacheManager = { get: jest.fn(), set: jest.fn(), del: jest.fn() };

    service = new OrdersService(
      ordersRepository,
      orderItemsRepository,
      usersService,
      productsService,
      cacheManager,
    );
  });

  describe('create (must decrement stock atomically inside a transaction)', () => {
    beforeEach(() => {
      productsService.findOne.mockImplementation((id: number) =>
        Promise.resolve({ id, name: `Product ${id}`, price: 10, stock: 5 }),
      );
      ordersRepository.findOne.mockResolvedValue({
        id: 100,
        status: OrderStatus.PENDING,
        total: 30,
      });
    });

    it('decrements stock for every item through the transactional manager and computes the total', async () => {
      const dto = {
        userId: 1,
        items: [
          { productId: 1, quantity: 2 },
          { productId: 2, quantity: 1 },
        ],
      } as any;

      await service.create(dto);

      expect(ordersRepository.manager.transaction).toHaveBeenCalledTimes(1);
      expect(productsService.decrementStock).toHaveBeenNthCalledWith(
        1,
        1,
        2,
        fakeManager,
      );
      expect(productsService.decrementStock).toHaveBeenNthCalledWith(
        2,
        2,
        1,
        fakeManager,
      );

      // total = 10*2 + 10*1 = 30, saved on the order inside the transaction
      const savedOrder =
        fakeManager.save.mock.results[fakeManager.save.mock.results.length - 1]
          .value;
      await expect(savedOrder).resolves.toMatchObject({ total: 30 });
    });

    it('rolls back and stops processing further items when stock is insufficient', async () => {
      productsService.decrementStock.mockRejectedValueOnce(
        new BadRequestException('Not enough stock for Product 1'),
      );

      const dto = {
        userId: 1,
        items: [
          { productId: 1, quantity: 999 },
          { productId: 2, quantity: 1 },
        ],
      } as any;

      await expect(service.create(dto)).rejects.toThrow(
        'Not enough stock for Product 1',
      );

      // second item must never be touched once the first one fails
      expect(productsService.findOne).toHaveBeenCalledTimes(1);
      expect(productsService.decrementStock).toHaveBeenCalledTimes(1);
    });
  });

  describe('cancel (must restore stock atomically and only for pending orders)', () => {
    it('restores stock for every item and marks the order as cancelled', async () => {
      fakeManager.findOne.mockResolvedValue({
        id: 5,
        status: OrderStatus.PENDING,
        items: [
          { productId: 1, quantity: 2 },
          { productId: 2, quantity: 3 },
        ],
      });

      const result = await service.cancel(5);

      expect(productsService.incrementStock).toHaveBeenNthCalledWith(
        1,
        1,
        2,
        fakeManager,
      );
      expect(productsService.incrementStock).toHaveBeenNthCalledWith(
        2,
        2,
        3,
        fakeManager,
      );
      expect(result.status).toBe(OrderStatus.CANCELLED);
    });

    it('throws BadRequestException without touching stock when the order is not pending', async () => {
      fakeManager.findOne.mockResolvedValue({
        id: 5,
        status: OrderStatus.SHIPPED,
        items: [{ productId: 1, quantity: 2 }],
      });

      await expect(service.cancel(5)).rejects.toThrow(BadRequestException);
      expect(productsService.incrementStock).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the order does not exist', async () => {
      fakeManager.findOne.mockResolvedValue(null);

      await expect(service.cancel(999)).rejects.toThrow(NotFoundException);
    });
  });

  describe('processPayment (bounded retries instead of up to 1000 attempts)', () => {
    beforeEach(() => {
      ordersRepository.findOne.mockResolvedValue({
        id: 1,
        total: '50.00',
        status: OrderStatus.PENDING,
      });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('confirms the order as soon as a payment attempt succeeds', async () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.5); // never below the 0.1 failure threshold

      const result = await service.processPayment(1);

      expect(result.success).toBe(true);
      expect(ordersRepository.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: OrderStatus.CONFIRMED }),
      );
    });

    it('gives up after a bounded number of retries instead of hanging indefinitely', async () => {
      jest.spyOn(Math, 'random').mockReturnValue(0.01); // always below the 0.1 failure threshold

      await expect(service.processPayment(1)).rejects.toThrow(
        /Payment failed for order #1 after 3 attempts/,
      );
      expect(ordersRepository.save).not.toHaveBeenCalled();
    }, 10000);
  });

  describe('getOrderWithFullDetails (must not build a circular structure)', () => {
    it('returns the loaded order as-is without throwing', async () => {
      const order = {
        id: 1,
        createdAt: new Date('2024-01-01'),
        user: { id: 1, name: 'Alice' },
        items: [],
      };
      ordersRepository.findOne.mockResolvedValue(order);

      const result = await service.getOrderWithFullDetails(1);

      expect(result).toBe(order);
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(() => JSON.stringify(result)).not.toThrow();
    });

    it('throws NotFoundException when the order does not exist', async () => {
      ordersRepository.findOne.mockResolvedValue(null);

      await expect(service.getOrderWithFullDetails(999)).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
