const errorHandler = (err, req, res, next) => {
  console.error('Unhandled Application Error:', err);

  let statusCode = err.statusCode || 500;
  let message = err.message || 'Internal Server Error';

  // Handle MySQL foreign key constraint failures (code 1452: ER_NO_REFERENCED_ROW_2)
  if (err.code === 'ER_NO_REFERENCED_ROW_2' || err.errno === 1452) {
    statusCode = 400;
    if (err.message && err.message.includes('tournament_matches_ibfk_3')) {
      message = 'Selected Team A does not exist or has been removed from the database.';
    } else if (err.message && err.message.includes('tournament_matches_ibfk_4')) {
      message = 'Selected Team B does not exist or has been removed from the database.';
    } else if (err.message && err.message.includes('tournament_matches_ibfk_1')) {
      message = 'Associated tournament does not exist.';
    } else {
      message = 'Invalid reference: One of the selected entities (Team, Court, or Venue) does not exist in the database.';
    }
  } else if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.errno === 1451) {
    statusCode = 400;
    message = 'Cannot delete or update this record because it is referenced by other items in the database.';
  } else if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) {
    statusCode = 409;
    message = 'A record with this information already exists.';
  }

  res.status(statusCode).json({
    success: false,
    message: message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack, details: err.message })
  });
};

module.exports = errorHandler;

