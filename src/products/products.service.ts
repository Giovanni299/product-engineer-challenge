import { Injectable, NotFoundException, BadRequestException, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Product } from './product.entity';
import { Category } from './category.entity';
import { CreateProductDto, CreateCategoryDto } from './dto/create-product.dto';

@Injectable()
export class ProductsService {
  constructor(
    @InjectRepository(Product)
    private productsRepository: Repository<Product>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    @Inject(CACHE_MANAGER)
    private cacheManager: Cache,
  ) {}

  async findAll(): Promise<Product[]> {
    return this.productsRepository.find({ relations: ['category'] });
  }

  async findOne(id: number): Promise<Product> {
    const product = await this.productsRepository.findOne({ 
      where: { id },
      relations: ['category'],
    });
    if (!product) {
      throw new NotFoundException(`Product #${id} not found`);
    }
    return product;
  }

  async create(createProductDto: CreateProductDto): Promise<Product> {
    const product = this.productsRepository.create(createProductDto);
    return this.productsRepository.save(product);
  }

  /**
   * Atomically decrements stock, failing if there isn't enough available.
   * Uses a conditional UPDATE instead of read-then-write to avoid lost
   * updates when concurrent orders touch the same product.
   */
  async decrementStock(id: number, quantity: number, manager?: EntityManager): Promise<void> {
    const repo = manager ? manager.getRepository(Product) : this.productsRepository;
    const result = await repo
      .createQueryBuilder()
      .update(Product)
      .set({ stock: () => 'stock - :quantity' })
      .where('id = :id AND stock >= :quantity', { id, quantity })
      .setParameters({ quantity })
      .execute();

    if (result.affected === 0) {
      const product = await repo.findOne({ where: { id } });
      if (!product) {
        throw new NotFoundException(`Product #${id} not found`);
      }
      throw new BadRequestException(`Not enough stock for ${product.name}`);
    }
  }

  /**
   * Atomically restores stock (e.g. when an order is cancelled).
   */
  async incrementStock(id: number, quantity: number, manager?: EntityManager): Promise<void> {
    const repo = manager ? manager.getRepository(Product) : this.productsRepository;
    const result = await repo
      .createQueryBuilder()
      .update(Product)
      .set({ stock: () => 'stock + :quantity' })
      .where('id = :id', { id, quantity })
      .setParameters({ quantity })
      .execute();

    if (result.affected === 0) {
      throw new NotFoundException(`Product #${id} not found`);
    }
  }

  async remove(id: number): Promise<void> {
    const product = await this.findOne(id);
    await this.productsRepository.remove(product);
  }

  async searchProducts(query: string): Promise<Product[]> {
    const cacheKey = `product-search:${query.trim().toLowerCase()}`;
    const cached = await this.cacheManager.get<Product[]>(cacheKey);
    if (cached) {
      return cached;
    }

    const products = await this.productsRepository.find();
    const results = products.filter(p => 
      p.name.toLowerCase().includes(query.toLowerCase()) ||
      (p.description || '').toLowerCase().includes(query.toLowerCase())
    );

    await this.cacheManager.set(cacheKey, results, 60000);
    return results;
  }

  async findAllCategories(): Promise<Category[]> {
    return this.categoriesRepository.find({ relations: ['parent', 'children'] });
  }

  async findCategory(id: number): Promise<Category> {
    const category = await this.categoriesRepository.findOne({
      where: { id },
      relations: ['parent', 'children', 'products'],
    });
    if (!category) {
      throw new NotFoundException(`Category #${id} not found`);
    }
    return category;
  }

  async createCategory(dto: CreateCategoryDto): Promise<Category> {
    const category = this.categoriesRepository.create(dto);
    return this.categoriesRepository.save(category);
  }

  async getCategoryTree(categoryId: number): Promise<any> {
    const category = await this.findCategory(categoryId);
    return this.buildCategoryTree(category);
  }

  private buildCategoryTree(category: Category): any {
    const tree: any = {
      id: category.id,
      name: category.name,
      children: [],
    };

    if (category.parent) {
      tree.parent = this.buildCategoryTree(category.parent);
    }

    if (category.children && category.children.length > 0) {
      tree.children = category.children.map(child => this.buildCategoryTree(child));
    }

    return tree;
  }

  async processProductBatch(productIds: number[]): Promise<{ success: boolean; processed: number }> {
    let processed = 0;
    
    try {
      for (const id of productIds) {
        try {
          const product = await this.findOne(id);
          product.updatedAt = new Date();
          await this.productsRepository.save(product);
          processed++;
        } catch (error) {
          console.log('Error processing product');
        }
      }
    } catch (error) {
      throw new BadRequestException('Batch processing failed');
    }

    return { success: true, processed };
  }
}
