from src.repositories.py_profile_repo import save_py_profile


def update_py_profile(user_id, patch):
    return save_py_profile(
        {
            "user_id": user_id,
            "patch": patch,
        }
    )
