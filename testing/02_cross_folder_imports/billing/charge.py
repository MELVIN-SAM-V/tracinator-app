def charge(amount: float, user_id: str) -> None:
    if amount <= 0:
        raise ValueError("Amount must be positive")
    print(f"Charged {amount} to {user_id}")

def refund(amount: float, user_id: str) -> bool:
    if amount > 1000:
        return False
    print(f"Refunded {amount} to {user_id}")
    return True
