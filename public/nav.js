// Lets views switch tabs without importing the app shell (avoids circular imports).
let navigator = () => {};

export const setNavigator = (fn) => { navigator = fn; };
export const navigate = (view) => navigator(view);
