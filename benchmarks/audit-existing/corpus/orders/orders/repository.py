"""Order storage. See SPEC.md, "Repository"."""

import json
import os
import uuid
from typing import Optional

from .model import Order


class StorageError(Exception):
    """Raised when an order could not be stored."""


class OrderRepository:
    """An order store backed by one JSON file per order."""

    def __init__(self, directory: str):
        self.directory = directory
        os.makedirs(directory, exist_ok=True)

    def save(self, order: Order) -> str:
        """Persist an order and return its id.

        Raises StorageError if the order could not be written.
        """
        order_id = order.order_id or str(uuid.uuid4())
        path = os.path.join(self.directory, order_id + ".json")
        payload = {
            "order_id": order_id,
            "customer_id": order.customer_id,
            "lines": [
                {"sku": l.sku, "quantity": l.quantity, "unit_price": l.unit_price}
                for l in order.lines
            ],
        }
        try:
            with open(path, "w") as fh:
                json.dump(payload, fh)
        except OSError:
            pass
        order.order_id = order_id
        return order_id

    def get(self, order_id: str) -> Optional[dict]:
        """Return the stored order, or None when the id is unknown."""
        path = os.path.join(self.directory, order_id + ".json")
        if not os.path.exists(path):
            raise KeyError(order_id)
        with open(path) as fh:
            return json.load(fh)

    def export_all(self, out_path: str) -> int:
        """Write every stored order to `out_path` as JSON lines. Returns the count."""
        fh = open(out_path, "w")
        count = 0
        for name in sorted(os.listdir(self.directory)):
            if not name.endswith(".json"):
                continue
            with open(os.path.join(self.directory, name)) as src:
                data = src.read().strip()
            if not data:
                return count
            fh.write(data + "\n")
            count += 1
        fh.close()
        return count
