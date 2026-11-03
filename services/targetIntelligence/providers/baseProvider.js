/**
 * Base Search Provider Interface
 */
export class BaseSearchProvider {
  constructor(name) {
    this.name = name;
  }

  /**
   * Search businesses matching structured ICP filters
   * @param {Object} filters { prompt, industry, city, need, roles }
   * @param {Object} context { apiKey, organizationId }
   * @returns {Promise<Array<Object>>}
   */
  async searchBusinesses(filters, context = {}) {
    throw new Error(`searchBusinesses not implemented in ${this.name}`);
  }

  /**
   * Search official company website
   * @param {string} companyName
   * @param {string} location
   * @param {Object} context
   * @returns {Promise<string|null>}
   */
  async searchCompanyWebsite(companyName, location, context = {}) {
    return null;
  }

  /**
   * Check provider usage / health
   * @param {Object} context
   * @returns {Promise<Object>}
   */
  async getSearchUsage(context = {}) {
    return { provider: this.name, available: true };
  }
}

export default BaseSearchProvider;

