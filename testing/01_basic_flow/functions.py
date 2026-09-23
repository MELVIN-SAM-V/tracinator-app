def process_payment(amount: float, user_id: str) -> bool:
    user = get_user(user_id)
    balance = user["balance"]

    if balance >= amount:
        try:
            charge(amount, user_id)
            return True
        except ValueError as e:
            log_error(e)
            return False
    else:
        notify_insufficient(user_id)
        return False


def get_user(user_id: str) -> dict:
    return {"id": user_id, "balance": 1000.0}


def charge(amount: float, user_id: str) -> None:
    if amount <= 0:
        raise ValueError("Amount must be positive")
    print(f"Charged {amount} to {user_id}")


def log_error(error: Exception) -> None:
    print(f"Error: {error}")


def notify_insufficient(user_id: str) -> None:
    print(f"Insufficient balance for {user_id}")


def loop_example(items: list) -> list:
    result = []
    for item in items:
        if item > 0:
            result.append(item)
        elif item == 0:
            continue
        else:
            break
    return result


def while_example(n: int) -> int:
    count = 0
    while n > 0:
        n -= 1
        count += 1
    return count
