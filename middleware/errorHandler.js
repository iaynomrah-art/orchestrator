import { StatusCodes } from "http-status-codes";

export const errorHandler = (err, req, res, next) => {
  console.error(err);

  let customError = {
    statusCode: err.statusCode || StatusCodes.INTERNAL_SERVER_ERROR,
    error: {
      message: err.message || "Something went wrong. Please try again later",
      code: err.statusCode || null,
    },
  };

  if (err.name === "ValidationError") {
    customError.message = Object.values(err.errors)
      .map((item) => item.message)
      .join(",");
    customError.statusCode = 400;
  }
  if (err.code && err.code === 11000) {
    customError.error.message = `Duplicate value entered for ${Object.keys(
      err.keyValue
    )} field, please choose another value`;
    customError.statusCode = 400;
  }
  if (err.name === "CastError") {
    customError.error.message = `No item found with id : ${err.value}`;
    customError.statusCode = 404;
  }

  return res.status(customError.statusCode).json({ error: customError.error });
};
