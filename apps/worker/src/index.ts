import { createVendingWorker } from "@openclaw-control-plane/vending-worker";

const vendingWorker = createVendingWorker();

console.log(`worker ready: ${vendingWorker.name}`);
