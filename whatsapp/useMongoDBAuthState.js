// Deprecated: Baileys connection engine is fully decommissioned.
// Official Meta WhatsApp Cloud API (Coexistence Embedded Signup v4) handles all authentication stateless-ly via Bearer access tokens.

export const useMongoDBAuthState = async (sessionId, AuthStateModel) => {
  return {
    state: {
      creds: {},
      keys: {
        get: async () => ({}),
        set: async () => {},
      },
    },
    saveCreds: async () => {},
  };
};

export default useMongoDBAuthState;
