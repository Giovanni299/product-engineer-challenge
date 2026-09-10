/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ProductsService } from './products.service';
import { Product } from './product.entity';

describe('ProductsService', () => {
  let service: ProductsService;
  let queryBuilder: any;
  let productsRepository: any;
  let categoriesRepository: any;
  let cacheManager: any;

  beforeEach(() => {
    queryBuilder = {
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      setParameters: jest.fn().mockReturnThis(),
      execute: jest.fn(),
    };

    productsRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((data) => data),
      save: jest.fn((data) => data),
      remove: jest.fn(),
      createQueryBuilder: jest.fn(() => queryBuilder),
    };

    categoriesRepository = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((data) => data),
      save: jest.fn((data) => data),
    };

    cacheManager = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
    };

    service = new ProductsService(
      productsRepository,
      categoriesRepository,
      cacheManager,
    );
  });

  describe('decrementStock (atomic stock decrement)', () => {
    it('succeeds silently when there is enough stock', async () => {
      queryBuilder.execute.mockResolvedValue({ affected: 1 });

      await expect(service.decrementStock(1, 2)).resolves.toBeUndefined();

      expect(queryBuilder.where).toHaveBeenCalledWith(
        'id = :id AND stock >= :quantity',
        { id: 1, quantity: 2 },
      );
    });

    it('throws BadRequestException instead of allowing overselling when stock is insufficient', async () => {
      queryBuilder.execute.mockResolvedValue({ affected: 0 });
      productsRepository.findOne.mockResolvedValue({ id: 1, name: 'Widget' });

      await expect(service.decrementStock(1, 100)).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.decrementStock(1, 100)).rejects.toThrow(
        'Not enough stock for Widget',
      );
    });

    it('throws NotFoundException when the product does not exist', async () => {
      queryBuilder.execute.mockResolvedValue({ affected: 0 });
      productsRepository.findOne.mockResolvedValue(null);

      await expect(service.decrementStock(999, 1)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('runs against a provided transactional manager instead of the default repository', async () => {
      queryBuilder.execute.mockResolvedValue({ affected: 1 });
      const managerRepo = { createQueryBuilder: jest.fn(() => queryBuilder) };
      const manager: any = { getRepository: jest.fn(() => managerRepo) };

      await service.decrementStock(1, 1, manager);

      expect(manager.getRepository).toHaveBeenCalledWith(Product);
      expect(managerRepo.createQueryBuilder).toHaveBeenCalled();
      expect(productsRepository.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('incrementStock (atomic stock restore)', () => {
    it('succeeds silently when the product exists', async () => {
      queryBuilder.execute.mockResolvedValue({ affected: 1 });

      await expect(service.incrementStock(1, 3)).resolves.toBeUndefined();
      expect(queryBuilder.where).toHaveBeenCalledWith('id = :id', {
        id: 1,
        quantity: 3,
      });
    });

    it('throws NotFoundException when the product does not exist', async () => {
      queryBuilder.execute.mockResolvedValue({ affected: 0 });

      await expect(service.incrementStock(999, 1)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('searchProducts (cache key must depend on the query)', () => {
    const widget = { id: 1, name: 'Widget', description: '' };
    const gadget = { id: 2, name: 'Gadget', description: '' };

    beforeEach(() => {
      productsRepository.find.mockResolvedValue([widget, gadget]);
    });

    it('caches results under a key that includes the search query', async () => {
      cacheManager.get.mockResolvedValue(undefined);

      await service.searchProducts('Widget');

      expect(cacheManager.get).toHaveBeenCalledWith('product-search:widget');
      expect(cacheManager.set).toHaveBeenCalledWith(
        'product-search:widget',
        [widget],
        60000,
      );
    });

    it('does not reuse a previous query cache entry for a different search term', async () => {
      cacheManager.get.mockResolvedValue(undefined);

      await service.searchProducts('widget');
      await service.searchProducts('gadget');

      const cacheKeysUsed = cacheManager.get.mock.calls.map(
        (call: any[]) => call[0],
      );
      expect(cacheKeysUsed).toEqual([
        'product-search:widget',
        'product-search:gadget',
      ]);
      expect(new Set(cacheKeysUsed).size).toBe(2);
    });

    it('normalizes the query so casing/whitespace share the same cache entry', async () => {
      cacheManager.get.mockResolvedValue(undefined);

      await service.searchProducts('  Widget  ');

      expect(cacheManager.get).toHaveBeenCalledWith('product-search:widget');
    });
  });

  describe('getCategoryTree (must not crash on partially loaded hierarchies)', () => {
    it('builds a tree without recursing into an unloaded grandparent', async () => {
      const child: any = {
        id: 3,
        name: 'Child',
        parentId: 2,
        parent: {
          id: 2,
          name: 'Parent',
          parentId: 1,
          parent: undefined,
          children: [],
        },
        children: [],
      };
      categoriesRepository.findOne.mockResolvedValue(child);

      const tree = await service.getCategoryTree(3);

      expect(tree).toEqual({
        id: 3,
        name: 'Child',
        children: [],
        parent: { id: 2, name: 'Parent', children: [] },
      });
    });

    it('builds a tree with no parent key for a root category', async () => {
      const root: any = {
        id: 1,
        name: 'Root',
        parentId: null,
        parent: undefined,
        children: [],
      };
      categoriesRepository.findOne.mockResolvedValue(root);

      const tree = await service.getCategoryTree(1);

      expect(tree).toEqual({ id: 1, name: 'Root', children: [] });
    });
  });
});
