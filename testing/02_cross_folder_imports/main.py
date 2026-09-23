from billing.charge import charge, refund

def process_order(amount: float, user_id: str) -> str:
    if amount <= 0:
        raise ValueError("Invalid amount")
    try:
        charge(amount, user_id)
        return "charged"
    except ValueError:
        refund(amount, user_id)
        return "refunded"
